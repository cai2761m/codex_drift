"""End-to-end HTTP checks. Synthetic data only; never calls a paid provider."""

import argparse
import json
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8080/api"


def request(path, body=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={
            "Content-Type": "application/json",
            "traceparent": "00-11111111111111111111111111111111-2222222222222222-01",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as response:
        assert response.headers["x-trace-id"] == "11111111111111111111111111111111"
        return json.load(response)


def run(body):
    job = request("/runs", body)
    assert job["status"] == "queued"
    for _ in range(80):
        result = request("/runs/" + job["id"])
        if result["status"] == "completed":
            return result
        assert result["status"] != "failed", result.get("error")
        time.sleep(0.1)
    raise AssertionError("job did not complete")


def main(expected_database=None):
    health = request("/health")
    assert health["status"] == "ok"
    assert health["analyzer"] is True, health
    if expected_database is not None:
        assert health["database"] == expected_database, health
    assert request("/benchmarks")["count"] == 8
    body = {
        "title": "健康基线 · 演示",
        "mode": "demo",
        "requested_model": "demo-codex",
        "repetitions": 3,
        "api_style": "responses",
        "reasoning_effort": "default",
        "scenario": "healthy",
    }
    baseline = run(body)
    assert baseline["report"]["score"] == 100
    request("/baseline", {"run_id": baseline["id"]}, "PUT")
    for scenario, title in [
        ("healthy", "对照复测 · 演示"),
        ("degraded", "能力下降 · 演示"),
        ("rerouted", "模型名异常 · 演示"),
    ]:
        result = run({**body, "scenario": scenario, "title": title})
        if scenario == "healthy":
            assert result["report"]["comparison"]["status"] == "stable"
        else:
            assert result["report"]["comparison"]["status"] == "regression"
            assert result["report"]["route"]["status"] == (
                "mismatch" if scenario == "rerouted" else "consistent"
            )
    imported = request(
        "/import",
        {
            "title": "Codex 会话 · 示例",
            "expected_model": "demo-codex",
            "content": "\n".join(  # noqa: FLY002
                [
                    '{"type":"turn_context","payload":{"model":"demo-codex","effort":"high"}}',
                    '{"type":"turn.completed","usage":{"input_tokens":250,"output_tokens":40}}',
                ]
            ),
        },
    )
    assert imported["report"]["route"]["status"] == "unknown"
    assert imported["report"]["score"] is None
    try:
        request("/baseline", {"run_id": imported["id"]}, "PUT")
        raise AssertionError("imported session accepted as capability baseline")
    except urllib.error.HTTPError as error:
        assert error.code == 400
    data = request("/runs")
    assert data["baseline_id"] == baseline["id"]
    assert len(data["runs"]) >= 5
    assert "samples" not in data["runs"][0]["report"]
    print(
        f"PASS: Rust → Python → {health['database']}; "
        "baseline, regression, metadata mismatch, import, trace propagation."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8080/api")
    parser.add_argument("--expect-database", choices=["SQLite", "PostgreSQL"])
    args = parser.parse_args()
    BASE = args.base_url.rstrip("/")
    main(args.expect_database)

