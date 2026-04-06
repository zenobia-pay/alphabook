#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from collections import defaultdict
from pathlib import Path
import urllib.request


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill corpus_chunk_id payloads into Qdrant using deterministic Gutenberg chunk assignments.")
    parser.add_argument("--map-file", required=True)
    parser.add_argument("--qdrant-url", default=os.environ.get("QDRANT_URL"))
    parser.add_argument("--qdrant-api-key", default=os.environ.get("QDRANT_API_KEY"))
    parser.add_argument("--collection", default=os.environ.get("QDRANT_COLLECTION"))
    parser.add_argument("--batch-chunks", type=int, default=1)
    return parser.parse_args()


def request(base_url: str, api_key: str | None, path: str, body: dict) -> dict:
    headers = {"content-type": "application/json"}
    if api_key:
        headers["api-key"] = api_key
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/{path.lstrip('/')}",
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=3600) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    args = parse_args()
    if not args.qdrant_url or not args.collection:
        raise SystemExit("QDRANT_URL and QDRANT_COLLECTION are required")

    payload = json.loads(Path(args.map_file).read_text(encoding="utf-8"))
    grouped: dict[str, list[str]] = defaultdict(list)
    for row in payload.get("rows", []):
        if not isinstance(row, dict):
            continue
        corpus_chunk_id = row.get("corpus_chunk_id")
        gutenberg_id = row.get("gutenberg_id")
        if isinstance(corpus_chunk_id, str) and isinstance(gutenberg_id, str):
            grouped[corpus_chunk_id].append(gutenberg_id)

    chunk_ids = sorted(grouped.keys())
    results: list[dict[str, object]] = []
    for index in range(0, len(chunk_ids), max(1, args.batch_chunks)):
        for corpus_chunk_id in chunk_ids[index:index + max(1, args.batch_chunks)]:
            gutenberg_ids = sorted(set(grouped[corpus_chunk_id]))
            response = request(
                args.qdrant_url,
                args.qdrant_api_key,
                f"collections/{args.collection}/points/payload?wait=true",
                {
                    "payload": {
                        "corpus_chunk_id": corpus_chunk_id,
                    },
                    "filter": {
                        "must": [
                            {
                                "key": "gutenberg_id",
                                "match": {
                                    "any": gutenberg_ids,
                                },
                            }
                        ]
                    },
                },
            )
            results.append({
                "corpus_chunk_id": corpus_chunk_id,
                "gutenberg_id_count": len(gutenberg_ids),
                "response": response,
            })

    print(json.dumps({"ok": True, "results": results}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
