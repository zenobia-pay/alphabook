import asyncio

from alphabook.agents import CodexCliRunner, LocalBookAgentRunner, TerminalUseCliRunner
from alphabook.config import load_settings
from alphabook.embeddings import HashedEmbeddingProvider
from alphabook.models import ResearchMode
from alphabook.orchestrator import ResearchOrchestrator
from alphabook.pipeline import CorpusPipeline
from alphabook.search import SearchService
from alphabook.storage import CorpusStore


def build_test_services(tmp_path):
    settings = load_settings(tmp_path)
    store = CorpusStore(settings.db_path)
    embedder = HashedEmbeddingProvider(dimensions=128)
    pipeline = CorpusPipeline(settings, store, embedder)
    search_service = SearchService(store, embedder)
    codex_runner = CodexCliRunner(settings)
    local_runner = LocalBookAgentRunner(store, embedder)
    terminal_runner = TerminalUseCliRunner(settings)
    orchestrator = ResearchOrchestrator(store, search_service, codex_runner, local_runner, terminal_runner)
    return settings, store, pipeline, search_service, orchestrator


def test_fast_search_prefers_relevant_book(tmp_path):
    _, _, pipeline, search_service, _ = build_test_services(tmp_path)
    pipeline.ingest_text(
        book_id="don-quixote",
        title="Don Quixote",
        author="Miguel de Cervantes",
        text="The knight rode toward the windmills with a cracked lance. " * 40,
        source_url="local://don",
    )
    pipeline.ingest_text(
        book_id="moby-dick",
        title="Moby-Dick",
        author="Herman Melville",
        text="The captain pursued the white whale across the sea. " * 40,
        source_url="local://moby",
    )

    result = search_service.fast_search("windmills and knight", top_books=2, top_chunks=4)
    assert result.relevant_books[0].book.id == "don-quixote"
    assert result.embedding_hits[0].book.id == "don-quixote"


def test_slow_research_falls_back_to_local_runner(tmp_path):
    _, _, pipeline, _, orchestrator = build_test_services(tmp_path)
    pipeline.ingest_text(
        book_id="don-quixote",
        title="Don Quixote",
        author="Miguel de Cervantes",
        text="There was grief, sorrow, and sadness in the village. " * 50,
        source_url="local://don",
    )

    report = asyncio.run(orchestrator.research("sadness and grief", mode=ResearchMode.SLOW, top_books=1))
    assert report.agent_runner == "local-deep-scan"
    assert report.agents
    assert report.agents[0].evidence
    assert "sadness" in report.agents[0].evidence[0].excerpt.lower()


def test_slow_research_stays_on_selected_book(tmp_path):
    _, _, pipeline, _, orchestrator = build_test_services(tmp_path)
    pipeline.ingest_text(
        book_id="don-quixote",
        title="Don Quixote",
        author="Miguel de Cervantes",
        text="The knight charged the windmills and dreamed of giants. " * 40,
        source_url="local://don",
    )
    pipeline.ingest_text(
        book_id="grief-book",
        title="Book of Grief",
        author="Test Author",
        text="There was sadness, grief, and mourning in every room. " * 40,
        source_url="local://grief",
    )

    report = asyncio.run(
        orchestrator.research(
            "sadness and grief",
            mode=ResearchMode.SLOW,
            top_books=2,
            top_chunks=4,
            book_id="don-quixote",
        )
    )

    assert [candidate.book.id for candidate in report.candidate_books] == ["don-quixote"]
    assert [agent.book.id for agent in report.agents] == ["don-quixote"]
