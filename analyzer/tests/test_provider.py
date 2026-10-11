import json

import httpx
import pytest
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from drift.app import app, provider
from drift.benchmarks import PROBES
from drift.provider import query


@pytest.mark.parametrize("style", ["responses", "chat"])
async def test_live_request_shape_and_metadata(monkeypatch, style):
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("PROVIDER_BASE_URL", "https://provider.test/v1")

    def handle(request):
        assert request.headers["authorization"] == "Bearer synthetic-test-key"
        assert request.headers["x-client-request-id"]
        body = json.loads(request.content)
        assert body["model"] == "target"
        if style == "responses":
            assert request.url.path == "/v1/responses"
            assert body["store"] is False
            assert body["reasoning"] == {"effort": "high"}
            payload = {
                "model": "target-2026-01-01",
                "id": "resp_test",
                "status": "completed",
                "output": [{"type": "message", "content": [{"type": "output_text", "text": "2545"}]}],
                "usage": {
                    "input_tokens": 12,
                    "output_tokens": 30,
                    "total_tokens": 42,
                    "output_tokens_details": {"reasoning_tokens": 20},
                },
            }
        else:
            assert request.url.path == "/v1/chat/completions"
            assert body["reasoning_effort"] == "high"
            payload = {
                "model": "target",
                "choices": [{"message": {"content": "2545"}, "finish_reason": "stop"}],
                "usage": {"total_tokens": 42},
            }
        return httpx.Response(200, json=payload, headers={"x-request-id": "req_test"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        sample = await query(
            client,
            PROBES[0],
            {"mode": "live", "requested_model": "target", "api_style": style, "reasoning_effort": "high"},
            1,
        )
    assert sample["output"] == "2545"
    assert sample["request_id"] == "req_test"
    assert sample["total_tokens"] == 42
    assert sample["error"] is None


async def test_upstream_error_body_not_retained(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-test-key")
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(429, json={"error": "private secret"}))
    ) as client:
        sample = await query(client, PROBES[0], {"mode": "live", "requested_model": "target"}, 1)
    assert "429" in sample["error"]
    assert "private secret" not in json.dumps(sample)


async def test_w3c_parent_reaches_analysis_span():
    memory = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(memory))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://analyzer.test"
    ) as client:
        response = await client.post(
            "/evaluate",
            json={"mode": "demo", "requested_model": "demo-codex", "repetitions": 1},
            headers={"traceparent": "00-11111111111111111111111111111111-2222222222222222-01"},
        )
    assert response.status_code == 200
    spans = [s for s in memory.get_finished_spans() if s.name == "benchmark.evaluate"]
    assert spans
    assert format(spans[0].context.trace_id, "032x") == "11111111111111111111111111111111"


@pytest.mark.parametrize("payload", [[], {"usage": "invalid"}, {"output": ["invalid"]}, {"model": 42}])
async def test_malformed_upstream_is_a_sample_error(monkeypatch, payload):
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-test-key")
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=payload))
    ) as client:
        sample = await query(client, PROBES[0], {"mode": "live", "requested_model": "target"}, 1)
    assert sample["error"]
