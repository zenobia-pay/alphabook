#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a deterministic Gutenberg-to-corpus-chunk map for bounded vector search.")
    parser.add_argument("--precomputed-index-dir", required=True)
    parser.add_argument("--chunk-size", type=int, default=5000)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def load_metadata(metadata_path: Path) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for raw_line in metadata_path.read_text(encoding="utf-8").splitlines():
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        row = json.loads(raw_line)
        gutenberg_id = str(row.get("gutenberg_id") or "").strip()
        if not gutenberg_id:
            continue
        for key in ("primary_text_path", "primary_text_link_path", "clean_path"):
            value = row.get(key)
            if isinstance(value, str) and value.strip():
                mapping[value] = gutenberg_id
    return mapping


def main() -> int:
    args = parse_args()
    if args.chunk_size <= 0:
      raise SystemExit("--chunk-size must be positive")
    precomputed_index_dir = Path(args.precomputed_index_dir)
    all_text_files = precomputed_index_dir / "all-text-files.tsv"
    metadata_table = precomputed_index_dir / "metadata-table.jsonl"
    if not all_text_files.is_file():
        raise SystemExit(f"Missing text manifest: {all_text_files}")
    if not metadata_table.is_file():
        raise SystemExit(f"Missing metadata table: {metadata_table}")

    path_to_gutenberg = load_metadata(metadata_table)
    rows: list[dict[str, object]] = []
    ordinal = 0

    for raw_line in all_text_files.read_text(encoding="utf-8").splitlines():
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        parts = raw_line.split("\t", 1)
        if len(parts) != 2:
            continue
        size_text, absolute_path = parts
        if size_text == "size_bytes" and absolute_path == "absolute_path":
            continue
        ordinal += 1
        gutenberg_id = path_to_gutenberg.get(absolute_path)
        if not gutenberg_id:
            continue
        chunk_ordinal = ((ordinal - 1) // args.chunk_size) + 1
        rows.append({
            "ordinal": ordinal,
            "gutenberg_id": gutenberg_id,
            "absolute_path": absolute_path,
            "corpus_chunk_id": f"corpus-files{args.chunk_size}-{chunk_ordinal:05d}",
            "chunk_ordinal": chunk_ordinal,
        })

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps({
        "chunk_size": args.chunk_size,
        "row_count": len(rows),
        "rows": rows,
    }, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
