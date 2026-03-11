from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.request import urlopen

from .catalogue import get_seed
from .chunking import chunk_text
from .config import Settings
from .embeddings import BaseEmbeddingProvider, average_vectors
from .models import BookRecord, ChunkRecord
from .storage import CorpusStore
from .text import slugify, strip_project_gutenberg_boilerplate


class CorpusPipeline:
    def __init__(self, settings: Settings, store: CorpusStore, embedder: BaseEmbeddingProvider):
        self.settings = settings
        self.store = store
        self.embedder = embedder
        self.store.initialize()

    def ingest_seed(self, seed_id: str) -> BookRecord:
        seed = get_seed(seed_id)
        raw_text = self._download_text(seed.source_url)
        text = (
            strip_project_gutenberg_boilerplate(raw_text)
            if seed.source_format == "gutenberg_txt"
            else raw_text.strip()
        )
        return self.ingest_text(
            book_id=seed.id,
            title=seed.title,
            author=seed.author,
            text=text,
            source_url=seed.source_url,
        )

    def ingest_url(
        self,
        book_id: str,
        title: str,
        author: str,
        source_url: str,
        source_format: str = "plain_text",
    ) -> BookRecord:
        raw_text = self._download_text(source_url)
        text = (
            strip_project_gutenberg_boilerplate(raw_text)
            if source_format == "gutenberg_txt"
            else raw_text.strip()
        )
        return self.ingest_text(
            book_id=book_id,
            title=title,
            author=author,
            text=text,
            source_url=source_url,
        )

    def ingest_text(
        self,
        book_id: str,
        title: str,
        author: str,
        text: str,
        source_url: str,
    ) -> BookRecord:
        canonical_book_id = slugify(book_id)
        created_at = datetime.now(timezone.utc).isoformat()
        checksum = hashlib.sha256(text.encode("utf-8")).hexdigest()
        content_path = self.settings.raw_dir / f"{canonical_book_id}.txt"
        content_path.write_text(text, encoding="utf-8")

        book = BookRecord(
            id=canonical_book_id,
            title=title,
            author=author,
            source_url=source_url,
            content_path=str(content_path),
            checksum=checksum,
            text_length=len(text),
            created_at=created_at,
        )

        chunk_drafts = chunk_text(text)
        chunks = [
            ChunkRecord(
                id=f"{book.id}:{draft.chunk_index:05d}",
                book_id=book.id,
                chunk_index=draft.chunk_index,
                start_char=draft.start_char,
                end_char=draft.end_char,
                content=draft.content,
            )
            for draft in chunk_drafts
        ]

        chunk_vectors = self.embedder.embed_texts([chunk.content for chunk in chunks]) if chunks else []
        book_vector = average_vectors(chunk_vectors)

        self.store.upsert_book(book)
        self.store.replace_chunks(book.id, chunks)

        if chunk_vectors:
            self.store.replace_chunk_embeddings(
                {
                    chunk.id: chunk_vectors[index]
                    for index, chunk in enumerate(chunks)
                },
                model=self.embedder.model_name,
                updated_at=created_at,
            )
            self.store.replace_book_embedding(
                book_id=book.id,
                model=self.embedder.model_name,
                vector=book_vector,
                updated_at=created_at,
            )

        return book

    def _download_text(self, source_url: str) -> str:
        with urlopen(source_url, timeout=30) as response:
            payload = response.read()
        return payload.decode("utf-8", errors="ignore")
