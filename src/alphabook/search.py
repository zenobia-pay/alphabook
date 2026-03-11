from __future__ import annotations

from typing import Dict, List, Sequence

from .embeddings import BaseEmbeddingProvider, cosine_similarity
from .models import BookRecord, ScoredBook, SearchBundle, SearchHit
from .storage import CorpusStore
from .text import make_excerpt, tokenize


def score_text_query(query: str, text: str) -> float:
    query_tokens = tokenize(query)
    if not query_tokens:
        return 0.0

    lower = text.lower()
    score = 0.0
    joined_query = " ".join(query_tokens)
    if joined_query and joined_query in lower:
        score += 6.0

    for token in query_tokens:
        count = lower.count(token)
        if count:
            score += 1.0 + min(count, 5) * 0.5
    return score


class SearchService:
    def __init__(self, store: CorpusStore, embedder: BaseEmbeddingProvider):
        self.store = store
        self.embedder = embedder

    def fast_search(self, query: str, top_books: int = 3, top_chunks: int = 8) -> SearchBundle:
        books = self.store.list_books()
        if not books:
            raise RuntimeError("No books indexed. Run 'alphabook ingest-seed don-quixote' first.")

        books_by_id = {book.id: book for book in books}
        query_vector = self.embedder.embed_texts([query])[0]
        book_vectors = self.store.get_embeddings("book", [book.id for book in books])

        relevant_books = sorted(
            [
                ScoredBook(
                    book=book,
                    score=cosine_similarity(query_vector, book_vectors.get(book.id, [])),
                    strategy="book-embedding",
                )
                for book in books
            ],
            key=lambda item: item.score,
            reverse=True,
        )[:top_books]

        candidate_book_ids = [item.book.id for item in relevant_books] or [book.id for book in books[:top_books]]

        chunks = [chunk for chunk in self.store.list_chunks() if chunk.book_id in candidate_book_ids]
        chunk_vectors = self.store.get_embeddings("chunk", [chunk.id for chunk in chunks])

        embedding_hits = sorted(
            [
                SearchHit(
                    book=books_by_id[chunk.book_id],
                    chunk=chunk,
                    score=(0.75 * cosine_similarity(query_vector, chunk_vectors.get(chunk.id, [])))
                    + (0.25 * next((item.score for item in relevant_books if item.book.id == chunk.book_id), 0.0)),
                    strategy="chunk-embedding",
                    excerpt=make_excerpt(chunk.content, query),
                )
                for chunk in chunks
            ],
            key=lambda item: item.score,
            reverse=True,
        )[:top_chunks]

        text_hits = sorted(
            [
                SearchHit(
                    book=books_by_id[chunk.book_id],
                    chunk=chunk,
                    score=score_text_query(query, chunk.content),
                    strategy="plain-text",
                    excerpt=make_excerpt(chunk.content, query),
                )
                for chunk in chunks
            ],
            key=lambda item: item.score,
            reverse=True,
        )[:top_chunks]

        return SearchBundle(
            query=query,
            relevant_books=relevant_books,
            embedding_hits=embedding_hits,
            text_hits=text_hits,
        )

    def fast_search_book(self, query: str, book_id: str, top_chunks: int = 8) -> SearchBundle:
        book = self.store.get_book(book_id)
        if not book:
            raise RuntimeError(f"Book not found: {book_id}")

        query_vector = self.embedder.embed_texts([query])[0]
        book_vector = self.store.get_embeddings("book", [book.id]).get(book.id, [])
        relevant_books = [
            ScoredBook(
                book=book,
                score=cosine_similarity(query_vector, book_vector),
                strategy="book-embedding",
            )
        ]

        chunks = self.store.list_chunks(book.id)
        chunk_vectors = self.store.get_embeddings("chunk", [chunk.id for chunk in chunks])
        embedding_hits = sorted(
            [
                SearchHit(
                    book=book,
                    chunk=chunk,
                    score=(0.75 * cosine_similarity(query_vector, chunk_vectors.get(chunk.id, [])))
                    + (0.25 * relevant_books[0].score),
                    strategy="chunk-embedding",
                    excerpt=make_excerpt(chunk.content, query),
                )
                for chunk in chunks
            ],
            key=lambda item: item.score,
            reverse=True,
        )[:top_chunks]

        text_hits = sorted(
            [
                SearchHit(
                    book=book,
                    chunk=chunk,
                    score=score_text_query(query, chunk.content),
                    strategy="plain-text",
                    excerpt=make_excerpt(chunk.content, query),
                )
                for chunk in chunks
            ],
            key=lambda item: item.score,
            reverse=True,
        )[:top_chunks]

        return SearchBundle(
            query=query,
            relevant_books=relevant_books,
            embedding_hits=embedding_hits,
            text_hits=text_hits,
        )
