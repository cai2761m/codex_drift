import copy
import json

import pytest
from fastapi.testclient import TestClient

from drift.analysis import model_matches, summarize
from drift.app import app
from drift.benchmarks import PROBES, grade
from drift.importer import analyze_import
from drift.provider import parse_response


def report(failed=(), error=False):
    return {
        "mode": "live",
        "requested_model": "target",
        "suite_version": "core-v1",
        "api_style": "responses",
        "reasoning_effort": "high",
        "provider_url": "https://example.test/v1",
        "samples": [
            {
                "probe_id": p.id,
                "category": p.category,
                "score": 0 if p.id in failed else 1,
                "latency_ms": 100,
                "returned_model": "target",
                "error": "timeout" if error and i == 0 else None,
                "total_tokens": None,
            }
            for i, p in enumerate(PROBES)
        ],
    }


@pytest.mark.parametrize("probe", PROBES, ids=lambda p: p.id)
def test_golden_answers(probe):
    assert grade(probe, json.dumps(probe.expected))[0] == 1
    assert grade(probe, "```json\n" + json.dumps(probe.expected) + "\n```")[0] == 0
    assert grade(probe, "null")[0] == 0


def test_alias_snapshot_match_is_narrow():
    assert model_matches("target", "target")
    assert model_matches("target", "target-2026-01-01")
    assert not model_matches("target", "target-mini")
    assert not model_matches("target", "target-other-2026-01-01")


def test_paired_regression_does_not_claim_route():
    baseline = summarize(report())
    current = summarize(report({p.id for p in PROBES}), baseline)
    assert current["comparison"]["status"] == "regression"
    assert current["comparison"]["delta_ci95_pp"] == [-100, -100]
    assert current["route"]["status"] == "consistent"
    assert current["total_tokens"] == 0


def test_incompatible_and_incomplete_do_not_claim_regression():
    baseline = summarize(report())
    current = report()
    current["reasoning_effort"] = "low"
    assert summarize(current, baseline)["comparison"]["status"] == "incompatible"
    assert summarize(report(error=True), baseline)["comparison"]["status"] == "insufficient"
    assert summarize(report(), summarize(report(error=True)))["comparison"]["status"] == "incompatible"


def test_metadata_missing_and_mismatch():
    current = report()
    for sample in current["samples"]:
        sample["returned_model"] = None
    assert summarize(copy.deepcopy(current))["route"]["status"] == "unknown"
    current["samples"][0]["returned_model"] = "different"
    assert summarize(current)["route"]["mismatch_count"] == 1


def test_configured_model_is_not_returned_model_and_secrets_not_saved():
    content = "\n".join(
        json.dumps(record)
        for record in [
            {"type": "session_meta", "payload": {"secret": "sk-secret"}},
            {"type": "turn_context", "payload": {"model": "target", "effort": "high", "auth": "sk-secret"}},
            {"type": "turn_context", "payload": {"model": "different", "effort": "low"}},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "private user content"}},
            {"type": "turn.completed", "usage": {"input_tokens": 20, "output_tokens": 5}},
        ]
    )
    result = analyze_import(content, "target")
    assert result["route"]["status"] == "unknown"
    assert result["score"] is None
    assert result["import_summary"]["configuration_changes"] == 1
    assert result["total_tokens"] == 25
    assert "sk-secret" not in json.dumps(result)
    assert "private user content" not in json.dumps(result)


def test_captured_api_metadata_mismatch():
    result = analyze_import(
        json.dumps(
            {
                "request": {"model": "target"},
                "response": {"body": {"id": "resp_123", "model": "other", "output": []}},
                "headers": {"authorization": "Bearer sk-secret", "x-request-id": "req_123"},
            }
        ),
        "target",
    )
    assert result["route"]["status"] == "mismatch"
    assert result["import_summary"]["responses"][0]["request_id"] == "req_123"
    assert "sk-secret" not in json.dumps(result)


@pytest.mark.parametrize("content", ['{"broken"', "[]", "[3]", '{"unrelated":true}'])
def test_invalid_import_is_rejected(content):
    with pytest.raises(ValueError):
        analyze_import(content, "target")


def test_response_usage_null_and_truncation():
    result = parse_response(
        {"status": "incomplete", "model": "target", "usage": None, "output": []}, "responses"
    )
    assert result["error"]
    assert result["reasoning_tokens"] is None
    result = parse_response(
        {
            "status": "completed",
            "model": "target",
            "usage": {"total_tokens": 15},
            "output": [
                {"type": "reasoning", "content": []},
                {"type": "message", "content": [{"type": "output_text", "text": "42"}]},
            ],
        },
        "responses",
    )
    assert result["output"] == "42"
    result = parse_response(
        {
            "choices": [{"message": {"content": "42"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2},
        },
        "chat",
    )
    assert result["input_tokens"] == 3
    assert result["output"] == "42"


def test_api_demo_and_validation():
    client = TestClient(app)
    body = {"requested_model": "demo-codex", "mode": "demo", "repetitions": 1}
    baseline = client.post("/evaluate", json=body).json()
    assert baseline["score"] == 100
    response = client.post("/evaluate", json={**body, "scenario": "rerouted", "baseline": baseline})
    assert response.status_code == 200
    assert response.json()["route"]["mismatch_count"] == 8
    assert response.json()["comparison"]["status"] == "regression"
    assert client.post("/evaluate", json={**body, "repetitions": 0}).status_code == 422
    assert client.get("/benchmarks").json()["count"] == 8


def test_live_requires_server_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    client = TestClient(app)
    assert client.post("/evaluate", json={"mode": "live", "requested_model": "target"}).status_code == 400
    assert "OPENAI_API_KEY" not in client.get("/config").json()


def test_stream_events_deduplicate_and_null_usage_is_safe():
    response = {"id": "resp_a", "model": "target"}
    result = analyze_import(
        "\n".join(
            json.dumps(record)
            for record in [
                {"type": "response.created", "response": response},
                {"type": "response.completed", "response": response},
                {"type": "response.completed", "response": response},
                {"type": "turn.completed", "usage": {"input_tokens": None, "output_tokens": None}},
                {
                    "type": "turn_context",
                    "payload": {"model": "target", "effort": {"secret": "do-not-retain"}},
                },
            ]
        ),
        "target",
    )
    assert result["sample_count"] == 1
    assert result["total_tokens"] == 0
    assert "do-not-retain" not in json.dumps(result)


def test_incomplete_response_keeps_identity_and_consumed_tokens():
    current = report(error=True)
    current["samples"][0]["returned_model"] = "different"
    current["samples"][0]["total_tokens"] = 42
    result = summarize(current)
    assert result["route"]["mismatch_count"] == 1
    assert result["total_tokens"] == 42
