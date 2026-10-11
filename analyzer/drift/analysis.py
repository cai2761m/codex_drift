"""Separate metadata anomalies from paired capability regression. No identity classifier."""

import math
import random
import statistics


def model_matches(requested: str, returned: str) -> bool:
    if requested == returned:
        return True
    # Only the exact alias plus a YYYY-MM-DD snapshot is accepted.
    suffix = returned.removeprefix(requested + "-")
    import re

    return returned.startswith(requested + "-") and bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", suffix))


def grouped_scores(samples: list[dict]) -> dict[str, float]:
    grouped: dict[str, list] = {}
    for sample in samples:
        if not sample.get("error"):
            grouped.setdefault(sample["probe_id"], []).append(sample["score"])
    return {key: statistics.mean(values) for key, values in grouped.items()}


def compare(current: dict, baseline: dict | None) -> dict:
    if baseline is None:
        return {
            "status": "no_baseline",
            "label": "等待建立基线",
            "reason": "先保存同配置的健康检测作为基线。",
        }
    fields = ("mode", "suite_version", "requested_model", "api_style", "reasoning_effort", "provider_url")
    differences = [key for key in fields if current.get(key) != baseline.get(key)]
    if differences:
        return {
            "status": "incompatible",
            "label": "基线配置不同",
            "reason": "不可直接比较：" + ", ".join(differences),
        }
    if baseline.get("error_count", 0) or not baseline.get("samples"):
        return {"status": "incompatible", "label": "基线不完整", "reason": "基线必须包含全部有效测试。"}
    left = grouped_scores(current["samples"])
    right = grouped_scores(baseline["samples"])
    # Do not cherry-pick surviving probes when API failures occur.
    if current.get("error_count", 0) or left.keys() != right.keys():
        return {
            "status": "insufficient",
            "label": "有效样本不足",
            "reason": "接口错误或测试项缺失，不能作能力退化判断。",
        }
    diffs = [left[key] - right[key] for key in sorted(left)]
    drop = -statistics.mean(diffs) * 100
    # Resample probe clusters, not repetitions; identical prompts are correlated.
    rng = random.Random(729)
    boot = sorted(statistics.mean(rng.choices(diffs, k=len(diffs))) * 100 for _ in range(4000))
    interval = [round(boot[100], 2), round(boot[3899], 2)]
    strong = len(diffs) >= 8 and drop >= 10 and interval[1] < 0
    status = "regression" if strong else "watch" if drop >= 10 else "stable"
    return {
        "status": status,
        "label": {
            "regression": "检测到能力退化信号",
            "watch": "分数下降，需复测",
            "stable": "未发现明显退化",
        }[status],
        "drop_pp": round(drop, 2),
        "delta_ci95_pp": interval,
        "paired_probes": len(diffs),
        "reason": "按测试项聚类的配对 bootstrap 95% 区间；小测试集仅作预警，不代表通用智力或真实模型身份。",
    }


def summarize(report: dict, baseline: dict | None = None) -> dict:
    samples = report["samples"]
    valid = [s for s in samples if not s.get("error")]
    scores = grouped_scores(samples)
    latencies = sorted(s["latency_ms"] for s in valid)
    mismatches = [
        s
        for s in samples
        if s.get("returned_model") and not model_matches(report["requested_model"], s["returned_model"])
    ]
    coverage = sum(bool(s.get("returned_model")) for s in samples)
    categories: dict[str, list] = {}
    for s in valid:
        categories.setdefault(s["category"], []).append(s["score"])
    report.update(
        {
            "score": round(statistics.mean(scores.values()) * 100, 2) if scores else None,
            "sample_count": len(samples),
            "valid_count": len(valid),
            "error_count": len(samples) - len(valid),
            "p50_ms": round(statistics.median(latencies)) if latencies else None,
            "p95_ms": round(latencies[max(0, math.ceil(len(latencies) * 0.95) - 1)]) if latencies else None,
            "total_tokens": sum(s.get("total_tokens") or 0 for s in samples),
            "metadata_coverage": round(coverage / len(samples) * 100) if samples else 0,
            "categories": {key: round(statistics.mean(vals) * 100, 2) for key, vals in categories.items()},
            "route": {
                "status": "mismatch"
                if mismatches
                else "consistent"
                if coverage == len(samples) and samples
                else "unknown",
                "mismatch_count": len(mismatches),
                "observed_models": sorted({s["returned_model"] for s in samples if s.get("returned_model")}),
                "label": "返回模型名异常"
                if mismatches
                else "返回模型名一致"
                if coverage == len(samples) and samples
                else "身份元数据不足",
                "reason": "模型名由服务端自报，中转服务可修改；字段一致也不能证明底层路由。",
            },
        }
    )
    report["comparison"] = compare(report, baseline)
    report["verdict"] = (
        "alert"
        if mismatches or report["comparison"]["status"] == "regression"
        else "watch"
        if report["error_count"] or report["comparison"]["status"] in ("watch", "insufficient")
        else "healthy"
    )
    return report
