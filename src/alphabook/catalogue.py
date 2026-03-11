from __future__ import annotations

from .models import BookSeed


SEED_BOOKS = {
    "don-quixote": BookSeed(
        id="don-quixote",
        title="Don Quixote",
        author="Miguel de Cervantes",
        source_url="https://www.gutenberg.org/cache/epub/996/pg996.txt",
    )
}


def get_seed(book_id: str) -> BookSeed:
    try:
        return SEED_BOOKS[book_id]
    except KeyError as exc:
        supported = ", ".join(sorted(SEED_BOOKS))
        raise KeyError(f"Unknown seed '{book_id}'. Supported seeds: {supported}") from exc
