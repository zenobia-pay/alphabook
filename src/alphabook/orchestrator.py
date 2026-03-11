from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Sequence

from .agents import LocalBookAgentRunner, TerminalUseCliRunner
from .models import BookAgentResult, BookRecord, ResearchMode, ResearchReport, ScoredBook, SearchHit
from .search import SearchService
from .storage import CorpusStore
from .text import unique_preserving_order


class ResearchOrchestrator:
    def __init__(
        self,
        store: CorpusStore,
        search_service: SearchService,
        local_runner: LocalBookAgentRunner,
        terminaluse_runner: TerminalUseCliRunner,
    ):
        self.store = store
        self.search_service = search_service
        self.local_runner = local_runner
        self.terminaluse_runner = terminaluse_runner

    async def research(
        self,
        query: str,
        mode: ResearchMode = ResearchMode.FAST,
        top_books: int = 3,
        top_chunks: int = 8,
    ) -> ResearchReport:
        search = self.search_service.fast_search(query, top_books=top_books, top_chunks=top_chunks)
        candidate_books = self._pick_candidate_books(mode, search.relevant_books)

        if mode == ResearchMode.FAST:
            return ResearchReport(
                query=query,
                mode=mode,
                search=search,
                candidate_books=candidate_books,
                agent_runner="search-only",
                availability_note="Fast mode uses embeddings and plain-text search only.",
                agents=[],
                synthesis=self._synthesize_fast(query, search),
            )

        hints_by_book = self._group_hints(search.embedding_hits + search.text_hits)
        available, availability_note = self.terminaluse_runner.availability()
        runner = self.terminaluse_runner if available else self.local_runner

        try:
            agent_results = await runner.run_many(
                query,
                [scored.book for scored in candidate_books],
                hints_by_book,
            )
            runner_name = runner.name
        except Exception as exc:
            agent_results = await self.local_runner.run_many(
                query,
                [scored.book for scored in candidate_books],
                hints_by_book,
            )
            runner_name = self.local_runner.name
            availability_note = f"{availability_note}; fell back locally because: {exc}"

        return ResearchReport(
            query=query,
            mode=mode,
            search=search,
            candidate_books=candidate_books,
            agent_runner=runner_name,
            availability_note=availability_note,
            agents=agent_results,
            synthesis=self._synthesize_deep(query, agent_results),
        )

    def _pick_candidate_books(self, mode: ResearchMode, relevant_books: Sequence[ScoredBook]) -> List[ScoredBook]:
        if mode == ResearchMode.NAIVE:
            return [
                ScoredBook(book=book, score=1.0, strategy="naive-all-books")
                for book in self.store.list_books()
            ]
        return list(relevant_books)

    @staticmethod
    def _group_hints(hits: Sequence[SearchHit]) -> Dict[str, List[SearchHit]]:
        by_book: Dict[str, List[SearchHit]] = defaultdict(list)
        seen: Dict[str, set] = defaultdict(set)
        for hit in hits:
            if hit.chunk.id in seen[hit.book.id]:
                continue
            seen[hit.book.id].add(hit.chunk.id)
            by_book[hit.book.id].append(hit)
        return by_book

    @staticmethod
    def _synthesize_fast(query: str, search) -> str:
        book_titles = ", ".join(f"{item.book.title} ({item.score:.3f})" for item in search.relevant_books[:3])
        hit_summaries = [
            f"{hit.book.title} chunk {hit.chunk.chunk_index}: {hit.excerpt}"
            for hit in search.embedding_hits[:2] + search.text_hits[:2]
        ]
        hit_text = " | ".join(unique_preserving_order(hit_summaries))
        return (
            f"Fast pass for '{query}' routed to {book_titles or 'no books'}. "
            f"Top evidence: {hit_text or 'no chunk hits'}."
        )

    @staticmethod
    def _synthesize_deep(query: str, results: Sequence[BookAgentResult]) -> str:
        if not results:
            return f"No deep research results were produced for '{query}'."
        joined = " ".join(result.summary for result in results)
        return f"Deep research for '{query}': {joined}"
