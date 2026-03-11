from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence

from .models import BookRecord, ChunkRecord


class CorpusStore:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                PRAGMA foreign_keys = ON;

                CREATE TABLE IF NOT EXISTS books (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    author TEXT NOT NULL,
                    source_url TEXT NOT NULL,
                    content_path TEXT NOT NULL,
                    checksum TEXT NOT NULL,
                    text_length INTEGER NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS chunks (
                    id TEXT PRIMARY KEY,
                    book_id TEXT NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    start_char INTEGER NOT NULL,
                    end_char INTEGER NOT NULL,
                    content TEXT NOT NULL,
                    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_chunks_book ON chunks(book_id, chunk_index);

                CREATE TABLE IF NOT EXISTS embeddings (
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    model TEXT NOT NULL,
                    vector_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (entity_type, entity_id)
                );
                """
            )

    def upsert_book(self, book: BookRecord) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO books (id, title, author, source_url, content_path, checksum, text_length, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    author = excluded.author,
                    source_url = excluded.source_url,
                    content_path = excluded.content_path,
                    checksum = excluded.checksum,
                    text_length = excluded.text_length,
                    created_at = excluded.created_at
                """,
                (
                    book.id,
                    book.title,
                    book.author,
                    book.source_url,
                    book.content_path,
                    book.checksum,
                    book.text_length,
                    book.created_at,
                ),
            )

    def replace_chunks(self, book_id: str, chunks: Sequence[ChunkRecord]) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM chunks WHERE book_id = ?", (book_id,))
            connection.execute(
                "DELETE FROM embeddings WHERE entity_type = 'chunk' AND entity_id LIKE ?",
                (f"{book_id}:%",),
            )
            connection.executemany(
                """
                INSERT INTO chunks (id, book_id, chunk_index, start_char, end_char, content)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        chunk.id,
                        chunk.book_id,
                        chunk.chunk_index,
                        chunk.start_char,
                        chunk.end_char,
                        chunk.content,
                    )
                    for chunk in chunks
                ],
            )

    def replace_book_embedding(self, book_id: str, model: str, vector: Sequence[float], updated_at: str) -> None:
        self._upsert_embedding("book", book_id, model, vector, updated_at)

    def replace_chunk_embeddings(
        self,
        vectors: Dict[str, Sequence[float]],
        model: str,
        updated_at: str,
    ) -> None:
        with self._connect() as connection:
            connection.executemany(
                """
                INSERT INTO embeddings (entity_type, entity_id, model, vector_json, updated_at)
                VALUES ('chunk', ?, ?, ?, ?)
                ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                    model = excluded.model,
                    vector_json = excluded.vector_json,
                    updated_at = excluded.updated_at
                """,
                [
                    (entity_id, model, json.dumps(list(vector)), updated_at)
                    for entity_id, vector in vectors.items()
                ],
            )

    def _upsert_embedding(
        self,
        entity_type: str,
        entity_id: str,
        model: str,
        vector: Sequence[float],
        updated_at: str,
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO embeddings (entity_type, entity_id, model, vector_json, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                    model = excluded.model,
                    vector_json = excluded.vector_json,
                    updated_at = excluded.updated_at
                """,
                (entity_type, entity_id, model, json.dumps(list(vector)), updated_at),
            )

    def list_books(self) -> List[BookRecord]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, title, author, source_url, content_path, checksum, text_length, created_at FROM books ORDER BY title"
            ).fetchall()
        return [self._book_from_row(row) for row in rows]

    def get_book(self, book_id: str) -> Optional[BookRecord]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id, title, author, source_url, content_path, checksum, text_length, created_at FROM books WHERE id = ?",
                (book_id,),
            ).fetchone()
        return self._book_from_row(row) if row else None

    def list_chunks(self, book_id: Optional[str] = None) -> List[ChunkRecord]:
        query = "SELECT id, book_id, chunk_index, start_char, end_char, content FROM chunks"
        params: Iterable[str]
        if book_id:
            query += " WHERE book_id = ?"
            params = (book_id,)
        else:
            params = ()
        query += " ORDER BY book_id, chunk_index"

        with self._connect() as connection:
            rows = connection.execute(query, tuple(params)).fetchall()
        return [self._chunk_from_row(row) for row in rows]

    def get_embeddings(self, entity_type: str, entity_ids: Optional[Sequence[str]] = None) -> Dict[str, List[float]]:
        query = "SELECT entity_id, vector_json FROM embeddings WHERE entity_type = ?"
        params: List[str] = [entity_type]
        if entity_ids:
            placeholders = ", ".join("?" for _ in entity_ids)
            query += f" AND entity_id IN ({placeholders})"
            params.extend(entity_ids)

        with self._connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return {row["entity_id"]: json.loads(row["vector_json"]) for row in rows}

    @staticmethod
    def _book_from_row(row: sqlite3.Row) -> BookRecord:
        return BookRecord(
            id=row["id"],
            title=row["title"],
            author=row["author"],
            source_url=row["source_url"],
            content_path=row["content_path"],
            checksum=row["checksum"],
            text_length=row["text_length"],
            created_at=row["created_at"],
        )

    @staticmethod
    def _chunk_from_row(row: sqlite3.Row) -> ChunkRecord:
        return ChunkRecord(
            id=row["id"],
            book_id=row["book_id"],
            chunk_index=row["chunk_index"],
            start_char=row["start_char"],
            end_char=row["end_char"],
            content=row["content"],
        )
