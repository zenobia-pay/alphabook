#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import urllib.request


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a bounded semantic search against Qdrant for one book or one deterministic corpus chunk.")
    parser.add_argument("--query", required=True)
    parser.add_argument("--top-k", type=int, default=20)
    parser.add_argument("--embedding-model", default=os.environ.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"))
    parser.add_argument("--embedding-dimensions", type=int, default=int(os.environ.get("OPENAI_EMBEDDING_DIMENSIONS", "768")))
    parser.add_argument("--openai-base-url", default=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"))
    parser.add_argument("--openai-api-key", default=os.environ.get("OPENAI_API_KEY"))
    parser.add_argument("--qdrant-url", default=os.environ.get("QDRANT_URL"))
    parser.add_argument("--qdrant-api-key", default=os.environ.get("QDRANT_API_KEY"))
    parser.add_argument("--collection", default=os.environ.get("QDRANT_COLLECTION"))
    parser.add_argument("--gutenberg-id", action="append", default=[])
    parser.add_argument("--gutenberg-ids-file")
    parser.add_argument("--corpus-chunk-id")
    parser.add_argument("--output")
    return parser.parse_args()


def read_ids(path: str | None) -> list[str]:
    if not path:
        return []
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(payload, dict) and isinstance(payload.get("gutenberg_ids"), list):
        return [str(entry).strip() for entry in payload["gutenberg_ids"] if str(entry).strip()]
    if isinstance(payload, list):
        return [str(entry).strip() for entry in payload if str(entry).strip()]
    return []


def post_json(url: str, body: dict, api_key: str | None, bearer: bool = False) -> dict:
    headers = {"content-type": "application/json"}
    if api_key:
        headers["authorization" if bearer else "api-key"] = f"Bearer {api_key}" if bearer else api_key
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers)
    with urllib.request.urlopen(req, timeout=300) as response:
        return json.loads(response.read().decode("utf-8"))


def build_filter(args: argparse.Namespace) -> dict | None:
    must: list[dict[str, object]] = []
    gutenberg_ids = sorted(set([entry.strip() for entry in args.gutenberg_id if entry.strip()] + read_ids(args.gutenberg_ids_file)))
    if args.corpus_chunk_id:
        must.append({"key": "corpus_chunk_id", "match": {"value": args.corpus_chunk_id}})
    if len(gutenberg_ids) == 1:
        must.append({"key": "gutenberg_id", "match": {"value": gutenberg_ids[0]}})
    elif len(gutenberg_ids) > 1:
        must.append({"key": "gutenberg_id", "match": {"any": gutenberg_ids}})
    return {"must": must} if must else None


def main() -> int:
    args = parse_args()
    if not args.openai_api_key:
        raise SystemExit("OPENAI_API_KEY is required")
    if not args.qdrant_url or not args.collection:
        raise SystemExit("QDRANT_URL and QDRANT_COLLECTION are required")

    embedding_request: dict[str, object] = {
        "model": args.embedding_model,
        "input": args.query,
    }
    if args.embedding_dimensions > 0 and args.embedding_model.startswith("text-embedding-3-"):
        embedding_request["dimensions"] = args.embedding_dimensions

    embedding_payload = post_json(
        f"{args.openai_base_url.rstrip('/')}/embeddings",
        embedding_request,
        args.openai_api_key,
        bearer=True,
    )
    data = embedding_payload.get("data") or []
    if not data or not isinstance(data[0], dict) or not isinstance(data[0].get("embedding"), list):
        raise SystemExit("Embedding response did not include a usable vector")
    vector = data[0]["embedding"]

    body: dict[str, object] = {
        "vector": vector,
        "limit": max(1, args.top_k),
        "with_payload": True,
        "with_vector": False,
    }
    payload_filter = build_filter(args)
    if payload_filter:
        body["filter"] = payload_filter

    result = post_json(
        f"{args.qdrant_url.rstrip('/')}/collections/{args.collection}/points/search",
        body,
        args.qdrant_api_key,
        bearer=False,
    )
    output = {
        "query": args.query,
        "top_k": max(1, args.top_k),
        "filter": payload_filter,
        "matches": result.get("result") or [],
    }
    rendered = json.dumps(output, indent=2, ensure_ascii=False)
    if args.output:
        Path(args.output).write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
