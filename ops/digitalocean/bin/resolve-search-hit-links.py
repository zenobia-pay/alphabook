#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Resolve corpus-search hits to AlphaBook reader links.")
    parser.add_argument("--inner-run-dir", required=True)
    parser.add_argument("--site-origin", default="https://alpha-book.org")
    parser.add_argument("--session-id", default="")
    return parser.parse_args()


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().lower()


def quote_fragments(normalized_quote: str) -> list[str]:
    words = [word for word in normalized_quote.split(" ") if word]
    if len(words) <= 20:
      return [normalized_quote] if normalized_quote else []
    fragments: list[str] = []
    window = 18
    step = 8
    for start in range(0, len(words), step):
      fragment = " ".join(words[start:start + window]).strip()
      if len(fragment) >= 80:
        fragments.append(fragment)
    return fragments or ([normalized_quote] if normalized_quote else [])


def derive_gutenberg_id(source_file: str) -> str | None:
    match = re.search(r"/gutenberg/clean/(\d+)/clean\.txt$", source_file)
    if match:
        return match.group(1)
    return None


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_chunks(chunks_path: Path) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    for line in chunks_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        record = json.loads(line)
        if isinstance(record, dict):
            chunks.append(record)
    return chunks


def resolve_chunk(hit: dict[str, Any], chunks: list[dict[str, Any]]) -> dict[str, Any] | None:
    quote = str(hit.get("quote") or "")
    normalized_quote = normalize_text(quote)
    if not normalized_quote:
        return None
    fragments = quote_fragments(normalized_quote)

    best_record: dict[str, Any] | None = None
    best_score = -1
    for chunk in chunks:
        haystack = normalize_text(str(chunk.get("text") or chunk.get("excerpt") or ""))
        if not haystack:
            continue
        score = -1
        if normalized_quote in haystack:
            score = 1_000_000 + len(normalized_quote)
        else:
            for fragment in fragments:
                if fragment in haystack:
                    score = max(score, len(fragment))
            if score < 0:
                quote_terms = {term for term in normalized_quote.split(" ") if len(term) >= 6}
                if quote_terms:
                    score = sum(1 for term in quote_terms if term in haystack)
        if score > best_score:
            best_score = score
            best_record = chunk
    if best_score <= 0:
        return None
    return best_record


def build_full_reader_path(gutenberg_id: str, reader_path: str | None) -> str | None:
    if not reader_path:
        return None
    trimmed = reader_path.strip()
    if not trimmed.startswith("/"):
        return None
    if re.match(r"^/\d+(?:/|$)", trimmed):
        return trimmed
    return f"/{gutenberg_id}{trimmed}"


def build_alphabook_url(site_origin: str, work_id: str, reader_path: str | None) -> str | None:
    if not work_id or not reader_path:
        return None
    return f"{site_origin.rstrip('/')}/?view=explore&reader={quote(reader_path, safe='')}&work={quote(work_id, safe='')}"


def rewrite_hit_markdown(path: Path, hit: dict[str, Any]) -> None:
    matched_terms = hit.get("matched_terms")
    lines = [
        f"hit_id: {hit.get('hit_id', '')}",
        f"source_file: {hit.get('source_file', '')}",
        f"source_title: {hit.get('source_title', '')}",
        f"source_author: {hit.get('source_author', '')}",
    ]
    if hit.get("work_id"):
        lines.append(f"work_id: {hit['work_id']}")
    if hit.get("chunk_id"):
        lines.append(f"chunk_id: {hit['chunk_id']}")
    if hit.get("chunk_index") is not None:
        lines.append(f"chunk_index: {hit['chunk_index']}")
    if hit.get("reader_path"):
        lines.append(f"reader_path: {hit['reader_path']}")
    if hit.get("passage_id"):
        lines.append(f"passage_id: {hit['passage_id']}")
    if hit.get("alphabook_url"):
        lines.append(f"alphabook_url: {hit['alphabook_url']}")
    lines.extend([
        f"matched_terms: {json.dumps(matched_terms if isinstance(matched_terms, list) else [], ensure_ascii=False)}",
        f"why_this_is_relevant: {hit.get('why_this_is_relevant', '')}",
        "",
        "Exact quoted chunk:",
        "",
        str(hit.get("quote") or ""),
        "",
    ])
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    args = parse_args()
    inner_run_dir = Path(args.inner_run_dir)
    hits_index_path = inner_run_dir / "hits" / "index.json"
    if not hits_index_path.exists():
        print(json.dumps({"ok": False, "reason": "missing_hits_index", "path": str(hits_index_path)}))
        return 1

    hits = load_json(hits_index_path)
    if not isinstance(hits, list):
        print(json.dumps({"ok": False, "reason": "invalid_hits_index"}))
        return 1

    chunks_cache: dict[str, list[dict[str, Any]]] = {}
    resolved_count = 0

    for hit in hits:
        if not isinstance(hit, dict):
            continue
        source_file = str(hit.get("source_file") or "")
        gutenberg_id = derive_gutenberg_id(source_file)
        if not gutenberg_id:
            continue
        chunks_path = Path(source_file).with_name("chunks.jsonl")
        if not chunks_path.exists():
            continue
        chunks = chunks_cache.get(str(chunks_path))
        if chunks is None:
            chunks = load_chunks(chunks_path)
            chunks_cache[str(chunks_path)] = chunks
        chunk = resolve_chunk(hit, chunks)
        if not chunk:
            continue
        reader_path = build_full_reader_path(gutenberg_id, str(chunk.get("reader_path") or ""))
        work_id = str(chunk.get("work_id") or f"local-gutenberg-{gutenberg_id}")
        chunk_id = str(chunk.get("id") or "")
        passage_id = None
        if reader_path and "#" in reader_path:
            passage_id = reader_path.split("#", 1)[1].strip() or None
        alphabook_url = build_alphabook_url(args.site_origin, work_id, reader_path)
        hit["gutenberg_id"] = gutenberg_id
        hit["work_id"] = work_id
        hit["chunk_id"] = chunk_id or None
        hit["chunk_index"] = chunk.get("chunk_index")
        hit["reader_path"] = reader_path
        hit["passage_id"] = passage_id
        hit["alphabook_url"] = alphabook_url
        resolved_count += 1

        hit_id = str(hit.get("hit_id") or "")
        if hit_id:
            hit_path = inner_run_dir / "hits" / f"{hit_id}.md"
            if hit_path.exists():
                rewrite_hit_markdown(hit_path, hit)

    hits_index_path.write_text(json.dumps(hits, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "inner_run_dir": str(inner_run_dir),
        "hits_total": len(hits),
        "hits_resolved": resolved_count,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
