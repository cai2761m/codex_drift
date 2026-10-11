"""Small, versioned, deterministic probes. Never execute model-generated code."""

import json
from dataclasses import dataclass

SUITE_VERSION = "core-v1"


@dataclass(frozen=True)
class Probe:
    id: str
    category: str
    title: str
    prompt: str
    expected: object


PROBES = [
    Probe(
        "arithmetic",
        "reasoning",
        "多步算术",
        "Compute (137 * 29) - (84 * 17). Return only a JSON integer.",
        2545,
    ),
    Probe(
        "logic",
        "reasoning",
        "约束推理",
        "Ada, Bo, Cy have distinct ranks 1, 2, 3 (1 is first). Ada is before Bo, Cy is before Ada. Return only a JSON array of names in order.",
        ["Cy", "Ada", "Bo"],
    ),
    Probe(
        "code",
        "coding",
        "代码语义",
        "What does this Python code print? a = [[0]] * 3; a[0].append(1); print(a). Return only the value as JSON.",
        [[0, 1], [0, 1], [0, 1]],
    ),
    Probe(
        "boundary",
        "coding",
        "边界条件",
        "A lower_bound implementation returns the first index i where arr[i] >= target, or len(arr). For arr=[1,3,3,7] and targets=[0,3,4,8], return only a JSON array of the four indices.",
        [0, 1, 3, 4],
    ),
    Probe(
        "instruction",
        "instruction",
        "格式与指令",
        'Return only this exact JSON object, without additional keys or prose: {"status":"ok","values":[2,4,6]}',
        {"status": "ok", "values": [2, 4, 6]},
    ),
    Probe(
        "extraction",
        "instruction",
        "信息提取",
        'Extract only active user IDs in ascending order as a JSON array. Records: [{"id":8,"active":true},{"id":2,"active":false},{"id":5,"active":true},{"id":1,"active":true}].',
        [1, 5, 8],
    ),
    Probe(
        "context",
        "context",
        "干扰信息检索",
        "The correct release code is ORCHID-729. "
        + "Ignore draft code MAPLE-111; it was cancelled. " * 48
        + "Return only a JSON string containing the correct release code.",
        "ORCHID-729",
    ),
    Probe(
        "sql",
        "coding",
        "SQL NULL 语义",
        "SQLite table t(x) contains [1,NULL,1,2,NULL]. Return a JSON object with the values of COUNT(*), COUNT(x), COUNT(DISTINCT x), under keys all, nonnull, distinct respectively. No prose.",
        {"all": 5, "nonnull": 3, "distinct": 2},
    ),
]


def grade(probe: Probe, text: str) -> tuple[float, str]:
    try:
        value = json.loads(text.strip())
    except (json.JSONDecodeError, TypeError):
        return 0.0, "输出不是要求的纯 JSON"
    # A bool must not be treated as the integer 1. Compare canonical JSON values.
    canonical = lambda v: json.dumps(v, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    passed = canonical(value) == canonical(probe.expected)
    return (1.0, "通过精确校验") if passed else (0.0, "结果与参考答案不一致")


def public_suite() -> dict:
    return {
        "version": SUITE_VERSION,
        "count": len(PROBES),
        "probes": [
            {"id": p.id, "category": p.category, "title": p.title, "prompt": p.prompt, "expected": p.expected}
            for p in PROBES
        ],
    }
