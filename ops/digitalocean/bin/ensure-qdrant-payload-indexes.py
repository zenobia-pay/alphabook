#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import urllib.request


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ensure Qdrant payload indexes exist for bounded vector search.")
    parser.add_argument("--qdrant-url", default=os.environ.get("QDRANT_URL"))
    parser.add_argument("--qdrant-api-key", default=os.environ.get("QDRANT_API_KEY"))
    parser.add_argument("--collection", default=os.environ.get("QDRANT_COLLECTION"))
    return parser.parse_args()


def request(base_url: str, api_key: str | None, path: str, body: dict | None = None, method: str = "POST") -> dict:
    headers = {"content-type": "application/json"}
    if api_key:
        headers["api-key"] = api_key
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(f"{base_url.rstrip('/')}/{path.lstrip('/')}", data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=300) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    args = parse_args()
    if not args.qdrant_url or not args.collection:
        raise SystemExit("QDRANT_URL and QDRANT_COLLECTION are required")

    fields = ["gutenberg_id", "source_id", "corpus_chunk_id"]
    results: list[dict[str, object]] = []
    for field in fields:
        payload = request(
            args.qdrant_url,
            args.qdrant_api_key,
            f"collections/{args.collection}/index?wait=true",
            {
                "field_name": field,
                "field_schema": "keyword",
            },
            method="PUT",
        )
        results.append({"field": field, "response": payload})

    print(json.dumps({"ok": True, "results": results}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
