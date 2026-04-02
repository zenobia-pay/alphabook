#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a scoped text file TSV from a precomputed metadata-table.sqlite index."
    )
    parser.add_argument("--index-dir", required=True, help="Directory containing metadata-table.sqlite.")
    parser.add_argument("--output-path", required=True, help="Destination TSV path.")
    parser.add_argument("--release-year-from", type=int)
    parser.add_argument("--release-year-to", type=int)
    parser.add_argument("--publication-year-from", type=int)
    parser.add_argument("--publication-year-to", type=int)
    parser.add_argument("--language")
    parser.add_argument("--primary-text-kind", choices=["clean", "raw"])
    parser.add_argument("--title-contains", action="append", default=[])
    parser.add_argument("--author-contains", action="append", default=[])
    parser.add_argument("--subject-contains", action="append", default=[])
    parser.add_argument("--bookshelf-contains", action="append", default=[])
    return parser.parse_args()


def add_like_filters(clauses: list[str], params: list[str], column: str, values: list[str]) -> None:
    for value in values:
        clauses.append(f"{column} LIKE ?")
        params.append(f"%{value}%")


def main() -> None:
    args = parse_args()
    index_dir = Path(args.index_dir).resolve()
    sqlite_path = index_dir / "metadata-table.sqlite"
    if not sqlite_path.is_file():
        raise SystemExit(f"Missing metadata-table.sqlite: {sqlite_path}")

    output_path = Path(args.output_path).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    clauses = ["1=1"]
    params: list[str | int] = []

    if args.release_year_from is not None:
        clauses.append("release_year >= ?")
        params.append(args.release_year_from)
    if args.release_year_to is not None:
        clauses.append("release_year <= ?")
        params.append(args.release_year_to)
    if args.publication_year_from is not None:
        clauses.append("publication_year >= ?")
        params.append(args.publication_year_from)
    if args.publication_year_to is not None:
        clauses.append("publication_year <= ?")
        params.append(args.publication_year_to)
    if args.language:
        clauses.append("language = ?")
        params.append(args.language)
    if args.primary_text_kind:
        clauses.append("primary_text_kind = ?")
        params.append(args.primary_text_kind)

    add_like_filters(clauses, params, "title", args.title_contains)
    add_like_filters(clauses, params, "authors_json", args.author_contains)
    add_like_filters(clauses, params, "subjects_json", args.subject_contains)
    add_like_filters(clauses, params, "bookshelves_json", args.bookshelf_contains)

    query = f"""
      SELECT primary_text_bytes, primary_text_link_path
      FROM books
      WHERE {" AND ".join(clauses)}
      ORDER BY CAST(gutenberg_id AS INTEGER)
    """

    conn = sqlite3.connect(sqlite_path)
    try:
        rows = conn.execute(query, params).fetchall()
    finally:
        conn.close()

    with output_path.open("w", encoding="utf-8") as handle:
        for byte_size, path in rows:
            handle.write(f"{byte_size}\t{path}\n")

    print(output_path)


if __name__ == "__main__":
    main()
