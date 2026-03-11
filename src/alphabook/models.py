from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional


@dataclass(frozen=True)
class BookSeed:
    id: str
    title: str
    author: str
    source_url: str
    source_format: str = "gutenberg_txt"


@dataclass(frozen=True)
class BookRecord:
    id: str
    title: str
    author: str
    source_url: str
    content_path: str
    checksum: str
    text_length: int
    created_at: str


@dataclass(frozen=True)
class ChunkDraft:
    chunk_index: int
    start_char: int
    end_char: int
    content: str


@dataclass(frozen=True)
class ChunkRecord:
    id: str
    book_id: str
    chunk_index: int
    start_char: int
    end_char: int
    content: str


@dataclass(frozen=True)
class ScoredBook:
    book: BookRecord
    score: float
    strategy: str


@dataclass(frozen=True)
class SearchHit:
    book: BookRecord
    chunk: ChunkRecord
    score: float
    strategy: str
    excerpt: str


@dataclass(frozen=True)
class SearchBundle:
    query: str
    relevant_books: List[ScoredBook]
    embedding_hits: List[SearchHit]
    text_hits: List[SearchHit]


@dataclass(frozen=True)
class Evidence:
    chunk_id: str
    chunk_index: int
    score: float
    strategy: str
    excerpt: str
    reason: str


@dataclass(frozen=True)
class BookAgentResult:
    book: BookRecord
    runner: str
    summary: str
    evidence: List[Evidence]
    task_id: Optional[str] = None
    output_path: Optional[str] = None


class ResearchMode(str, Enum):
    FAST = "fast"
    SLOW = "slow"
    NAIVE = "naive"


@dataclass(frozen=True)
class ResearchReport:
    query: str
    mode: ResearchMode
    search: SearchBundle
    candidate_books: List[ScoredBook]
    agent_runner: str
    availability_note: Optional[str]
    agents: List[BookAgentResult] = field(default_factory=list)
    synthesis: str = ""
