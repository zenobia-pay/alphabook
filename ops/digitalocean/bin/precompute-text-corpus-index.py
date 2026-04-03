#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import shutil
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
        "--no-primary-text",
        action="store_true",
        help="Do not create a primary-text alias folder; point manifests directly at clean.txt paths.",
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


SQLITE_SCHEMA = """
CREATE TABLE books (
  gutenberg_id TEXT PRIMARY KEY,
  source_manifest_path TEXT,
  source_manifest_mtime_ns INTEGER,
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
  clean_mtime_ns INTEGER,
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

SQLITE_INSERT = """
INSERT INTO books (
  gutenberg_id, source_manifest_path, source_manifest_mtime_ns, title, subtitle, authors_json, subjects_json, bookshelves_json,
  language, release_date, release_year, publication_year, publication_year_source,
  rights_status, summary, source_format, source_path, metadata_path, raw_path,
  clean_path, clean_mtime_ns, book_html_path, primary_text_kind, primary_text_path,
  primary_text_link_path, primary_text_bytes, has_raw, has_clean, has_book_html
) VALUES (
  :gutenberg_id, :source_manifest_path, :source_manifest_mtime_ns, :title, :subtitle, :authors_json, :subjects_json, :bookshelves_json,
  :language, :release_date, :release_year, :publication_year, :publication_year_source,
  :rights_status, :summary, :source_format, :source_path, :metadata_path, :raw_path,
  :clean_path, :clean_mtime_ns, :book_html_path, :primary_text_kind, :primary_text_path,
  :primary_text_link_path, :primary_text_bytes, :has_raw, :has_clean, :has_book_html
)
"""

FIELDNAMES = [
    "gutenberg_id",
    "source_manifest_path",
    "source_manifest_mtime_ns",
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
    "clean_mtime_ns",
    "book_html_path",
    "primary_text_kind",
    "primary_text_path",
    "primary_text_link_path",
    "primary_text_bytes",
    "has_raw",
    "has_clean",
    "has_book_html",
]


def init_sqlite(path: Path) -> sqlite3.Connection:
    if path.exists():
        path.unlink()
    conn = sqlite3.connect(path)
    conn.executescript(SQLITE_SCHEMA)
    return conn


def prepare_previous_sqlite(output_dir: Path) -> Path | None:
    previous_path = output_dir / "metadata-table.sqlite"
    backup_path = output_dir / "metadata-table.prev.sqlite"
    if backup_path.exists():
        backup_path.unlink()
    if previous_path.exists():
        shutil.move(previous_path, backup_path)
        return backup_path
    return None


def open_previous_lookup(path: Path | None) -> tuple[sqlite3.Connection | None, set[str]]:
    if not path or not path.exists():
        return None, set()
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    columns = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(books)")
    }
    return conn, columns


def fetch_existing_row(
    conn: sqlite3.Connection | None,
    columns: set[str],
    gutenberg_id: str,
) -> dict[str, Any] | None:
    if conn is None:
        return None
    row = conn.execute(
        "SELECT * FROM books WHERE gutenberg_id = ?",
        (gutenberg_id,),
    ).fetchone()
    if row is None:
        return None
    result = dict(row)
    for key in FIELDNAMES:
        if key not in result and key not in columns:
            result[key] = None
    return result


def maybe_reuse_existing_row(
    existing_row: dict[str, Any] | None,
    *,
    manifest_path: Path,
    clean_path: Path,
    primary_text_path: Path,
    primary_text_link_path: Path,
    primary_text_kind: str,
    primary_text_bytes: int,
    source_manifest_mtime_ns: int,
    clean_mtime_ns: int,
) -> dict[str, Any] | None:
    if not existing_row:
        return None

    existing_clean_path = str(existing_row.get("clean_path") or "")
    existing_primary_text_path = str(existing_row.get("primary_text_path") or "")
    existing_source_manifest_path = str(existing_row.get("source_manifest_path") or "")
    existing_source_manifest_mtime_ns = existing_row.get("source_manifest_mtime_ns")
    existing_clean_mtime_ns = existing_row.get("clean_mtime_ns")
    existing_primary_text_bytes = existing_row.get("primary_text_bytes")

    path_matches = (
        existing_clean_path == str(clean_path)
        and (
            existing_primary_text_path in ("", str(clean_path), str(primary_text_path))
        )
    )
    size_matches = int(existing_primary_text_bytes or -1) == primary_text_bytes

    # Backward-compatible fast path for rows written before the cache metadata existed.
    # If the canonical clean path and byte size are unchanged, hydrate the cache fields
    # in place and reuse the row instead of reparsing metadata.
    if (
        path_matches
        and size_matches
        and existing_source_manifest_path == ""
        and existing_source_manifest_mtime_ns in (None, "")
        and existing_clean_mtime_ns in (None, "")
    ):
        reused = dict(existing_row)
        reused["source_manifest_path"] = str(manifest_path)
        reused["source_manifest_mtime_ns"] = source_manifest_mtime_ns
        reused["clean_mtime_ns"] = clean_mtime_ns
        reused["primary_text_path"] = str(primary_text_path)
        reused["primary_text_link_path"] = str(primary_text_link_path)
        reused["primary_text_kind"] = primary_text_kind
        reused["primary_text_bytes"] = primary_text_bytes
        return reused

    if (
        existing_source_manifest_path == str(manifest_path)
        and int(existing_source_manifest_mtime_ns or -1) == source_manifest_mtime_ns
        and existing_clean_path == str(clean_path)
        and int(existing_clean_mtime_ns or -1) == clean_mtime_ns
        and size_matches
    ):
        reused = dict(existing_row)
        reused["primary_text_path"] = str(primary_text_path)
        reused["primary_text_link_path"] = str(primary_text_link_path)
        reused["primary_text_kind"] = primary_text_kind
        reused["primary_text_bytes"] = primary_text_bytes
        return reused

    return None


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
    if not args.no_primary_text:
        primary_text_root.mkdir(parents=True, exist_ok=True)

    total_primary_bytes = 0
    counts = {
        "books_total": 0,
        "books_with_clean": 0,
        "books_with_raw": 0,
        "books_with_book_html": 0,
        "primary_clean": 0,
        "books_missing_clean": 0,
    }
    counts["reused_rows"] = 0
    counts["rebuilt_rows"] = 0

    previous_sqlite_path = prepare_previous_sqlite(output_dir)
    previous_conn, previous_columns = open_previous_lookup(previous_sqlite_path)
    sqlite_conn = init_sqlite(output_dir / "metadata-table.sqlite")

    tsv_handle = (output_dir / "all-text-files.tsv").open("w", encoding="utf-8")
    jsonl_handle = (output_dir / "metadata-table.jsonl").open("w", encoding="utf-8")
    csv_handle = (output_dir / "metadata-table.csv").open("w", encoding="utf-8", newline="")
    csv_writer = csv.DictWriter(csv_handle, fieldnames=FIELDNAMES)
    csv_writer.writeheader()

    processed_since_commit = 0

    try:
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
            if args.no_primary_text:
                primary_text_link_path = primary_text_path
            else:
                primary_text_link_path = primary_text_root / f"{int(gutenberg_id):06d}.txt"
                ensure_link(primary_text_path, primary_text_link_path, args.link_mode)

            primary_text_bytes = primary_text_path.stat().st_size
            source_manifest_mtime_ns = manifest_path.stat().st_mtime_ns
            clean_mtime_ns = primary_text_path.stat().st_mtime_ns
            total_primary_bytes += primary_text_bytes
            tsv_handle.write(f"{primary_text_bytes}\t{primary_text_link_path}\n")

            reused_row = maybe_reuse_existing_row(
                fetch_existing_row(previous_conn, previous_columns, gutenberg_id),
                manifest_path=manifest_path,
                clean_path=clean_path,
                primary_text_path=primary_text_path,
                primary_text_link_path=primary_text_link_path,
                primary_text_kind=primary_text_kind,
                primary_text_bytes=primary_text_bytes,
                source_manifest_mtime_ns=source_manifest_mtime_ns,
                clean_mtime_ns=clean_mtime_ns,
            )
            if reused_row:
                row = reused_row
                counts["reused_rows"] += 1
            else:
                release_date = coerce_text(metadata.get("releaseDate"))
                release_year = year_from_date(release_date)
                publication_year, publication_year_source = infer_publication_year(metadata)
                authors = safe_list(metadata.get("authors"))
                subjects = safe_list(metadata.get("subjects"))
                bookshelves = safe_list(metadata.get("bookshelves"))

                row = {
                    "gutenberg_id": gutenberg_id,
                    "source_manifest_path": str(manifest_path),
                    "source_manifest_mtime_ns": source_manifest_mtime_ns,
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
                    "clean_mtime_ns": clean_mtime_ns,
                    "book_html_path": str(book_html_path) if book_html_path else None,
                    "primary_text_kind": primary_text_kind,
                    "primary_text_path": str(primary_text_path),
                    "primary_text_link_path": str(primary_text_link_path),
                    "primary_text_bytes": primary_text_bytes,
                    "has_raw": int(has_raw),
                    "has_clean": int(has_clean),
                    "has_book_html": int(has_book_html),
                }
                counts["rebuilt_rows"] += 1

            jsonl_handle.write(json.dumps(row, ensure_ascii=True) + "\n")
            csv_writer.writerow(row)
            sqlite_conn.execute(SQLITE_INSERT, row)
            processed_since_commit += 1
            if processed_since_commit >= 500:
                sqlite_conn.commit()
                csv_handle.flush()
                jsonl_handle.flush()
                tsv_handle.flush()
                processed_since_commit = 0
    finally:
        sqlite_conn.commit()
        tsv_handle.close()
        jsonl_handle.close()
        csv_handle.close()
        sqlite_conn.close()
        if previous_conn is not None:
            previous_conn.close()

    manifest = {
        "prepared_root": str(prepared_root),
        "primary_text_root": None if args.no_primary_text else str(primary_text_root),
        "file_type": "canonical-text-only",
        "selection_policy": {
            "preferred_source": "clean",
            "fallback_source": None,
            "requires_clean_text": True,
            "link_mode": None if args.no_primary_text else args.link_mode,
            "uses_primary_text_aliases": not args.no_primary_text,
        },
        "total_files": counts["primary_clean"],
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
