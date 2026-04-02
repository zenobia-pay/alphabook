#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import sqlite3
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build a precomputed corpus manifest and metadata index from prepared "
            "local Gutenberg artifacts."
        )
    )
    parser.add_argument(
        "--prepared-root",
        required=True,
        help="Prepared artifact root containing books/ and r2/ subdirectories.",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Destination directory for the precomputed manifest and metadata index.",
    )
    parser.add_argument(
        "--primary-text-dir-name",
        default="primary-text",
        help="Folder name to create under --output-dir for canonical text links.",
    )
    parser.add_argument(
        "--link-mode",
        choices=["symlink", "copy"],
        default="symlink",
        help="How to materialize canonical primary text files.",
    )
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def safe_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def year_from_date(value: str | None) -> int | None:
    if not value or len(value) < 4:
        return None
    try:
        return int(value[:4])
    except ValueError:
        return None


def coerce_text(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped if stripped else None
    return None


def infer_publication_year(metadata: dict[str, Any]) -> tuple[int | None, str | None]:
    for key in (
        "publicationYear",
        "originalPublicationYear",
        "publication_year",
        "original_publication_year",
    ):
        value = metadata.get(key)
        if isinstance(value, int):
            return value, key
        if isinstance(value, str):
            try:
                return int(value[:4]), key
            except ValueError:
                continue
    return None, None


def ensure_link(source: Path, destination: Path, mode: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() or destination.is_symlink():
        destination.unlink()
    if mode == "copy":
        destination.write_bytes(source.read_bytes())
        return
    destination.symlink_to(source)


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def build_sqlite(path: Path, rows: list[dict[str, Any]]) -> None:
    if path.exists():
        path.unlink()
    conn = sqlite3.connect(path)
    try:
        conn.executescript(
            """
            CREATE TABLE books (
              gutenberg_id TEXT PRIMARY KEY,
              title TEXT,
              subtitle TEXT,
              authors_json TEXT NOT NULL,
              subjects_json TEXT NOT NULL,
              bookshelves_json TEXT NOT NULL,
              language TEXT,
              release_date TEXT,
              release_year INTEGER,
              publication_year INTEGER,
              publication_year_source TEXT,
              rights_status TEXT,
              summary TEXT,
              source_format TEXT,
              source_path TEXT,
              metadata_path TEXT,
              raw_path TEXT,
              clean_path TEXT,
              book_html_path TEXT,
              primary_text_kind TEXT NOT NULL,
              primary_text_path TEXT NOT NULL,
              primary_text_link_path TEXT NOT NULL,
              primary_text_bytes INTEGER NOT NULL,
              has_raw INTEGER NOT NULL,
              has_clean INTEGER NOT NULL,
              has_book_html INTEGER NOT NULL
            );

            CREATE INDEX idx_books_release_year ON books (release_year);
            CREATE INDEX idx_books_publication_year ON books (publication_year);
            CREATE INDEX idx_books_language ON books (language);
            CREATE INDEX idx_books_primary_kind ON books (primary_text_kind);
            """
        )
        conn.executemany(
            """
            INSERT INTO books (
              gutenberg_id, title, subtitle, authors_json, subjects_json, bookshelves_json,
              language, release_date, release_year, publication_year, publication_year_source,
              rights_status, summary, source_format, source_path, metadata_path, raw_path,
              clean_path, book_html_path, primary_text_kind, primary_text_path,
              primary_text_link_path, primary_text_bytes, has_raw, has_clean, has_book_html
            ) VALUES (
              :gutenberg_id, :title, :subtitle, :authors_json, :subjects_json, :bookshelves_json,
              :language, :release_date, :release_year, :publication_year, :publication_year_source,
              :rights_status, :summary, :source_format, :source_path, :metadata_path, :raw_path,
              :clean_path, :book_html_path, :primary_text_kind, :primary_text_path,
              :primary_text_link_path, :primary_text_bytes, :has_raw, :has_clean, :has_book_html
            )
            """,
            rows,
        )
        conn.commit()
    finally:
        conn.close()


def main() -> None:
    args = parse_args()
    prepared_root = Path(args.prepared_root).resolve()
    output_dir = Path(args.output_dir).resolve()
    books_root = prepared_root / "books"
    r2_root = prepared_root / "r2"
    primary_text_root = output_dir / args.primary_text_dir_name

    if not books_root.is_dir():
        raise SystemExit(f"Missing books/ directory under prepared root: {books_root}")
    if not r2_root.is_dir():
        raise SystemExit(f"Missing r2/ directory under prepared root: {r2_root}")

    output_dir.mkdir(parents=True, exist_ok=True)
    primary_text_root.mkdir(parents=True, exist_ok=True)

    rows: list[dict[str, Any]] = []
    manifest_lines: list[str] = []
    total_primary_bytes = 0
    counts = {
        "books_total": 0,
        "books_with_clean": 0,
        "books_with_raw": 0,
        "books_with_book_html": 0,
        "primary_clean": 0,
        "books_missing_clean": 0,
    }

    for manifest_path in sorted(books_root.glob("*/manifest.json"), key=lambda path: int(path.parent.name)):
        book_manifest = load_json(manifest_path)
        gutenberg_id = str(book_manifest["gutenbergId"])
        metadata = book_manifest["d1Records"]["work"]["metadata_json"]
        r2_keys = book_manifest["r2Keys"]

        raw_path = r2_root / r2_keys["raw"] if r2_keys.get("raw") else None
        clean_path = r2_root / r2_keys["clean"] if r2_keys.get("clean") else None
        book_html_path = r2_root / r2_keys["bookHtml"] if r2_keys.get("bookHtml") else None

        has_clean = bool(clean_path and clean_path.is_file())
        has_raw = bool(raw_path and raw_path.is_file())
        has_book_html = bool(book_html_path and book_html_path.is_file())

        counts["books_total"] += 1
        counts["books_with_clean"] += int(has_clean)
        counts["books_with_raw"] += int(has_raw)
        counts["books_with_book_html"] += int(has_book_html)

        if not has_clean:
            counts["books_missing_clean"] += 1
            continue

        primary_text_kind = "clean"
        primary_text_path = clean_path
        counts["primary_clean"] += 1
        primary_text_link_path = primary_text_root / f"{int(gutenberg_id):06d}.txt"
        ensure_link(primary_text_path, primary_text_link_path, args.link_mode)

        primary_text_bytes = primary_text_path.stat().st_size
        total_primary_bytes += primary_text_bytes
        manifest_lines.append(f"{primary_text_bytes}\t{primary_text_link_path}\n")

        release_date = coerce_text(metadata.get("releaseDate"))
        release_year = year_from_date(release_date)
        publication_year, publication_year_source = infer_publication_year(metadata)
        authors = safe_list(metadata.get("authors"))
        subjects = safe_list(metadata.get("subjects"))
        bookshelves = safe_list(metadata.get("bookshelves"))

        row = {
            "gutenberg_id": gutenberg_id,
            "title": coerce_text(metadata.get("title")) or coerce_text(book_manifest.get("title")),
            "subtitle": coerce_text(metadata.get("subtitle")),
            "authors_json": json.dumps(authors, ensure_ascii=True),
            "subjects_json": json.dumps(subjects, ensure_ascii=True),
            "bookshelves_json": json.dumps(bookshelves, ensure_ascii=True),
            "language": coerce_text(metadata.get("language")),
            "release_date": release_date,
            "release_year": release_year,
            "publication_year": publication_year,
            "publication_year_source": publication_year_source,
            "rights_status": coerce_text(metadata.get("rightsStatus")),
            "summary": coerce_text(metadata.get("summary")),
            "source_format": coerce_text(metadata.get("sourceFormat")) or coerce_text(metadata.get("format")),
            "source_path": coerce_text(metadata.get("sourcePath")),
            "metadata_path": coerce_text(metadata.get("metadataPath")),
            "raw_path": str(raw_path) if raw_path else None,
            "clean_path": str(clean_path) if clean_path else None,
            "book_html_path": str(book_html_path) if book_html_path else None,
            "primary_text_kind": primary_text_kind,
            "primary_text_path": str(primary_text_path),
            "primary_text_link_path": str(primary_text_link_path),
            "primary_text_bytes": primary_text_bytes,
            "has_raw": int(has_raw),
            "has_clean": int(has_clean),
            "has_book_html": int(has_book_html),
        }
        rows.append(row)

    fieldnames = [
        "gutenberg_id",
        "title",
        "subtitle",
        "authors_json",
        "subjects_json",
        "bookshelves_json",
        "language",
        "release_date",
        "release_year",
        "publication_year",
        "publication_year_source",
        "rights_status",
        "summary",
        "source_format",
        "source_path",
        "metadata_path",
        "raw_path",
        "clean_path",
        "book_html_path",
        "primary_text_kind",
        "primary_text_path",
        "primary_text_link_path",
        "primary_text_bytes",
        "has_raw",
        "has_clean",
        "has_book_html",
    ]

    (output_dir / "all-text-files.tsv").write_text("".join(manifest_lines), encoding="utf-8")
    with (output_dir / "metadata-table.jsonl").open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=True) + "\n")
    write_csv(output_dir / "metadata-table.csv", rows, fieldnames)
    build_sqlite(output_dir / "metadata-table.sqlite", rows)

    manifest = {
        "prepared_root": str(prepared_root),
        "primary_text_root": str(primary_text_root),
        "file_type": "canonical-text-only",
        "selection_policy": {
            "preferred_source": "clean",
            "fallback_source": None,
            "requires_clean_text": True,
            "link_mode": args.link_mode,
        },
        "total_files": len(rows),
        "total_bytes": total_primary_bytes,
        "counts": counts,
        "paths": {
            "all_text_files_tsv": str(output_dir / "all-text-files.tsv"),
            "metadata_table_jsonl": str(output_dir / "metadata-table.jsonl"),
            "metadata_table_csv": str(output_dir / "metadata-table.csv"),
            "metadata_table_sqlite": str(output_dir / "metadata-table.sqlite"),
        },
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(output_dir)


if __name__ == "__main__":
    main()
