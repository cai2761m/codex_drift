import asyncio
import json
import os
import time
import uuid

import httpx
from opentelemetry import trace

from .benchmarks import Probe

tracer = trace.get_tracer("codex-drift.provider")


async def query(client: httpx.AsyncClient, probe: Probe, config: dict, repetition: int) -> dict:
    result = {
        "probe_id": probe.id,
        "title": probe.title,
        "category": probe.category,
        "repetition": repetition,
        "requested_model": config["requested_model"],
        "error": None,
    }
    if config["mode"] == "demo":
        await asyncio.sleep(0.025)
        scenario = config.get("scenario", "healthy")
        fail = scenario in ("degraded", "rerouted") and probe.id in (
            "logic",
            "code",
            "boundary",
            "context",
            "sql",
        )
        result.update(
            {
                "output": json.dumps(None if fail else probe.expected, ensure_ascii=False),
                "returned_model": "demo-small" if scenario == "rerouted" else config["requested_model"],
                "latency_ms": 340 + repetition * 17 + len(probe.id) * 19
                if fail
                else 950 + len(probe.id) * 63,
                "request_id": "demo-" + uuid.uuid4().hex[:12],
                "response_id": "demo-response",
                "input_tokens": 120,
                "output_tokens": 20 if fail else 84,
                "reasoning_tokens": 0 if fail else 64,
                "cached_tokens": 0,
                "total_tokens": 140 if fail else 204,
                "service_tier": "demo",
                "finish_reason": "completed",
                "system_fingerprint": None,
            }
        )
        return result
    key = os.getenv("OPENAI_API_KEY", "")
    if not key:
        raise ValueError("真实检测需要在分析服务的环境变量中设置 OPENAI_API_KEY。")
    base = os.getenv("PROVIDER_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    effort = config.get("reasoning_effort", "default")
    style = config.get("api_style", "responses")
    if style == "responses":
        endpoint = "/responses"
        body = {
            "model": config["requested_model"],
            "input": probe.prompt,
            "max_output_tokens": 2048,
            "store": False,
        }
        if effort != "default":
            body["reasoning"] = {"effort": effort}
    else:
        endpoint = "/chat/completions"
        body = {
            "model": config["requested_model"],
            "messages": [{"role": "user", "content": probe.prompt}],
            "max_completion_tokens": 2048,
        }
        if effort != "default":
            body["reasoning_effort"] = effort
    started = time.perf_counter()
    with tracer.start_as_current_span(
        "probe.request", attributes={"probe.id": probe.id, "gen_ai.request.model": config["requested_model"]}
    ):
        try:
            response = await client.post(
                base + endpoint,
                json=body,
                headers={
                    "Authorization": "Bearer " + key,
                    "X-Client-Request-Id": uuid.uuid4().hex,
                },
            )
            result["request_id"] = response.headers.get("x-request-id")
            if not response.is_success:
                result["error"] = f"上游 HTTP {response.status_code}；请使用 request_id 核查。"
                return result
            payload = response.json()
            result.update(parse_response(payload, style))
        except (httpx.HTTPError, ValueError, KeyError, TypeError, IndexError, AttributeError):
            result["error"] = "上游超时、网络异常或响应结构无效。"
        finally:
            result["latency_ms"] = round((time.perf_counter() - started) * 1000)
    return result


def parse_response(payload: dict, style: str) -> dict:
    if not isinstance(payload, dict):
        raise TypeError("response must be an object")
    usage = payload.get("usage") or {}
    if not isinstance(usage, dict):
        raise TypeError("usage must be an object")
    if style == "responses":
        output = "".join(
            part.get("text", "")
            for item in payload.get("output", [])
            if item.get("type") == "message"
            for part in item.get("content", [])
            if part.get("type") == "output_text"
        )
        finish = payload.get("status", "unknown")
        incoming, outgoing = usage.get("input_tokens"), usage.get("output_tokens")
        reasoning = (usage.get("output_tokens_details") or {}).get("reasoning_tokens")
        cached = (usage.get("input_tokens_details") or {}).get("cached_tokens")
    else:
        choice = payload["choices"][0]
        output = choice["message"].get("content") or ""
        finish = choice.get("finish_reason", "unknown")
        incoming, outgoing = usage.get("prompt_tokens"), usage.get("completion_tokens")
        reasoning = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens")
        cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens")

    def token(value):
        return value if type(value) is int and value >= 0 else None

    model = payload.get("model")
    if model is not None and not isinstance(model, str):
        raise TypeError("model must be a string")
    if not isinstance(output, str):
        raise TypeError("output must be a string")
    return {
        "output": output[:16000],
        "returned_model": payload.get("model"),
        "response_id": payload.get("id"),
        "input_tokens": token(incoming),
        "output_tokens": token(outgoing),
        "reasoning_tokens": token(reasoning),
        "cached_tokens": token(cached),
        "total_tokens": token(usage.get("total_tokens")),
        "service_tier": payload.get("service_tier"),
        "system_fingerprint": payload.get("system_fingerprint"),
        "finish_reason": finish,
        "error": None if finish in ("completed", "stop") else "响应未正常完成：" + str(finish),
    }
