"""Allowlisted metadata extraction for Codex exec JSONL / rollout JSONL / API captures."""

import json
from itertools import pairwise

from .analysis import model_matches

MAX_BYTES = 2 * 1024 * 1024


def analyze_import(content: str, expected_model: str) -> dict:
    if len(content.encode("utf-8")) > MAX_BYTES:
        raise ValueError("文件不能超过 2 MiB。")
    configurations, responses, usages, errors = [], [], [], []
    response_ids = set()
    records = []
    try:
        parsed = json.loads(content)
        records = parsed if isinstance(parsed, list) else [parsed]
    except json.JSONDecodeError:
        for index, line in enumerate(content.splitlines(), 1):
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                raise ValueError(f"第 {index} 行不是有效 JSON；请导入 JSON 或 JSONL。") from None
    for index, record in enumerate(records, 1):
        if not isinstance(record, dict):
            raise ValueError(f"第 {index} 条记录必须是 JSON 对象。")  # noqa: TRY004
        kind = record.get("type", "")
        payload = record.get("payload") or {}
        if not isinstance(payload, dict):
            payload = {}
        if kind == "turn_context" and isinstance(payload.get("model"), str) and payload["model"]:
            configurations.append(
                {
                    "line": index,
                    "model": payload["model"][:200],
                    "effort": text_field(payload.get("effort") or payload.get("reasoning_effort"), 40),
                    "timestamp": text_field(record.get("timestamp"), 64),
                }
            )
        response = record.get("response")
        if isinstance(response, dict):
            response = response.get("body", response)
        elif record.get("object") in ("response", "chat.completion"):
            response = record
        elif kind == "response.completed":
            response = payload.get("response") or record.get("response")
        if kind == "response.created":
            response = None
        if isinstance(response, dict) and isinstance(response.get("model"), str) and response["model"]:
            response_id = response.get("id")
            if isinstance(response_id, str) and response_id in response_ids:
                continue
            if isinstance(response_id, str):
                response_ids.add(response_id)
            headers = record.get("headers") or {}
            if not isinstance(headers, dict):
                headers = {}
            request = record.get("request") or {}
            if not isinstance(request, dict):
                request = {}
            requested = text_field(request.get("model")) or expected_model
            responses.append(
                {
                    "line": index,
                    "returned_model": str(response["model"])[:200],
                    "requested_model": str(requested)[:200],
                    "response_id": text_field(response.get("id")),
                    "request_id": text_field(headers.get("x-request-id") or record.get("request_id")),
                    "mismatch": bool(requested) and not model_matches(str(requested), str(response["model"])),
                }
            )
        if kind == "turn.completed" and isinstance(record.get("usage"), dict):
            usages.append(record["usage"])
        if kind == "event_msg" and payload.get("type") == "token_count":
            info = payload.get("info") or {}
            if isinstance(info, dict) and isinstance(info.get("last_token_usage"), dict):
                usages.append(info["last_token_usage"])
        if kind in ("error", "turn.failed"):
            # Keep event type only; arbitrary log messages may contain secrets.
            errors.append({"line": index, "type": kind})
    if not records or not (
        configurations
        or responses
        or usages
        or errors
        or any(str(r.get("type", "")).startswith(("thread.", "turn.", "item.")) for r in records)
    ):
        raise ValueError("未发现受支持的 Codex 事件或 API 响应。")
    mismatch_count = sum(r["mismatch"] for r in responses)
    changes = sum(a["model"] != b["model"] or a["effort"] != b["effort"] for a, b in pairwise(configurations))
    route_status = (
        "mismatch"
        if mismatch_count
        else "consistent"
        if responses and all(r["requested_model"] for r in responses)
        else "unknown"
    )
    return {
        "mode": "import",
        "suite_version": None,
        "requested_model": expected_model,
        "score": None,
        "samples": [],
        "sample_count": len(responses),
        "valid_count": len(responses),
        "error_count": len(errors),
        "p50_ms": None,
        "p95_ms": None,
        "categories": {},
        "total_tokens": sum(token_count(u) for u in usages),
        "metadata_coverage": 100 if responses else 0,
        "route": {
            "status": route_status,
            "mismatch_count": mismatch_count,
            "observed_models": sorted({r["returned_model"] for r in responses}),
            "label": "返回模型名异常"
            if mismatch_count
            else "返回模型名一致"
            if route_status == "consistent"
            else "无法确认路由",
            "reason": "配置记录仅说明客户端意图；响应元数据也仅是服务端声明。",
        },
        "comparison": {
            "status": "unavailable",
            "label": "日志无法评估能力",
            "reason": "任意会话没有标准答案；请运行固定测试集。",
        },
        "verdict": "alert" if mismatch_count else "watch" if changes or errors else "unknown",
        "import_summary": {
            "record_count": len(records),
            "configurations": configurations,
            "responses": responses,
            "configuration_changes": changes,
            "usage_event_count": len(usages),
            "errors": errors,
            "note": "仅保留白名单元数据，不保存原始会话、工具命令、提示词或认证信息。Token 事件可能重叠，仅作观测合计。",
        },
    }


def text_field(value, length=200) -> str | None:
    return value[:length] if isinstance(value, str) else None


def token_count(usage: dict) -> int:
    def value(key):
        number = usage.get(key)
        return number if type(number) is int and number >= 0 else 0

    return value("total_tokens") or value("input_tokens") + value("output_tokens")
