"""Import an explicitly selected local JSON/JSONL file into a running Codex Drift API."""

import argparse
import json
import urllib.error
import urllib.request
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Import Codex JSONL or captured API metadata")
    parser.add_argument("file", type=Path, help="An explicitly selected JSON or JSONL file")
    parser.add_argument("--model", default="", help="Expected model, optional")
    parser.add_argument("--title", default="Codex 会话观测")
    parser.add_argument("--api", default="http://127.0.0.1:8080")
    args = parser.parse_args()
    if args.file.stat().st_size > 2 * 1024 * 1024:
        parser.error("file must be <= 2 MiB")
    body = json.dumps(
        {
            "title": args.title,
            "expected_model": args.model,
            "content": args.file.read_text(encoding="utf-8-sig"),
        }
    ).encode()
    request = urllib.request.Request(
        args.api.rstrip("/") + "/api/import", data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        parser.error(json.load(error).get("error", "import failed"))
    print(
        json.dumps(
            {
                "id": result["id"],
                "route": result["report"]["route"],
                "configuration_changes": result["report"]["import_summary"]["configuration_changes"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
