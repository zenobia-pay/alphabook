from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import is_dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Optional

from .agents import LocalBookAgentRunner, TerminalUseCliRunner
from .catalogue import SEED_BOOKS
from .config import load_settings
from .embeddings import build_embedding_provider
from .models import ResearchMode
from .orchestrator import ResearchOrchestrator
from .pipeline import CorpusPipeline
from .search import SearchService
from .storage import CorpusStore


def build_services(root_dir: Optional[Path] = None) -> dict:
    settings = load_settings(root_dir)
    store = CorpusStore(settings.db_path)
    store.initialize()
    embedder = build_embedding_provider(settings)
    pipeline = CorpusPipeline(settings, store, embedder)
    search_service = SearchService(store, embedder)
    local_runner = LocalBookAgentRunner(store, embedder)
    terminaluse_runner = TerminalUseCliRunner(settings)
    orchestrator = ResearchOrchestrator(store, search_service, local_runner, terminaluse_runner)
    return {
        "settings": settings,
        "store": store,
        "embedder": embedder,
        "pipeline": pipeline,
        "search_service": search_service,
        "terminaluse_runner": terminaluse_runner,
        "orchestrator": orchestrator,
    }


def to_jsonable(value: Any) -> Any:
    if is_dataclass(value):
        return {
            field_name: to_jsonable(getattr(value, field_name))
            for field_name in value.__dataclass_fields__
        }
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {key: to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(item) for item in value]
    return value


def print_json(value: Any) -> None:
    print(json.dumps(to_jsonable(value), indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="alphabook", description="Corpus research loops for books")
    subparsers = parser.add_subparsers(dest="command", required=True)

    ingest_seed = subparsers.add_parser("ingest-seed", help="Download and index a built-in public-domain seed book")
    ingest_seed.add_argument("seed_id", choices=sorted(SEED_BOOKS))
    ingest_seed.add_argument("--json", action="store_true")

    ingest_url = subparsers.add_parser("ingest-url", help="Download and index a book from a URL")
    ingest_url.add_argument("--book-id", required=True)
    ingest_url.add_argument("--title", required=True)
    ingest_url.add_argument("--author", required=True)
    ingest_url.add_argument("--url", required=True)
    ingest_url.add_argument("--source-format", default="plain_text", choices=["plain_text", "gutenberg_txt"])
    ingest_url.add_argument("--json", action="store_true")

    list_books = subparsers.add_parser("list-books", help="List indexed books")
    list_books.add_argument("--json", action="store_true")

    search = subparsers.add_parser("search", help="Run the fast embeddings plus text search")
    search.add_argument("query")
    search.add_argument("--top-books", type=int, default=3)
    search.add_argument("--top-chunks", type=int, default=8)
    search.add_argument("--json", action="store_true")

    research = subparsers.add_parser("research", help="Run one of the three research loops")
    research.add_argument("query")
    research.add_argument("--mode", choices=[mode.value for mode in ResearchMode], default=ResearchMode.FAST.value)
    research.add_argument("--top-books", type=int, default=3)
    research.add_argument("--top-chunks", type=int, default=8)
    research.add_argument("--json", action="store_true")

    terminal = subparsers.add_parser("terminaluse-status", help="Show Terminal Use readiness")
    terminal.add_argument("--json", action="store_true")

    return parser


def _print_search(search_result) -> None:
    print(f"Query: {search_result.query}")
    print("")
    print("Relevant books:")
    for result in search_result.relevant_books:
        print(f"- {result.book.title} by {result.book.author} [{result.score:.3f}]")

    print("")
    print("Embedding hits:")
    for hit in search_result.embedding_hits[:5]:
        print(f"- {hit.book.title} chunk {hit.chunk.chunk_index} [{hit.score:.3f}] {hit.excerpt}")

    print("")
    print("Text hits:")
    for hit in search_result.text_hits[:5]:
        print(f"- {hit.book.title} chunk {hit.chunk.chunk_index} [{hit.score:.3f}] {hit.excerpt}")


def _print_research(report) -> None:
    print(f"Query: {report.query}")
    print(f"Mode: {report.mode.value}")
    print(f"Runner: {report.agent_runner}")
    if report.availability_note:
        print(f"Note: {report.availability_note}")
    print("")
    print(report.synthesis)
    if report.agents:
        print("")
        for agent in report.agents:
            print(f"{agent.book.title}:")
            print(agent.summary)
            for evidence in agent.evidence[:4]:
                print(f"- chunk {evidence.chunk_index} [{evidence.score:.3f}] {evidence.excerpt}")
            if agent.task_id:
                print(f"- task_id: {agent.task_id}")
            if agent.output_path:
                print(f"- output: {agent.output_path}")
            print("")


def main(argv: Optional[list[str]] = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    services = build_services()

    if args.command == "ingest-seed":
        book = services["pipeline"].ingest_seed(args.seed_id)
        if args.json:
            print_json(book)
        else:
            print(f"Indexed {book.title} by {book.author} into {book.content_path}")
        return

    if args.command == "ingest-url":
        book = services["pipeline"].ingest_url(
            book_id=args.book_id,
            title=args.title,
            author=args.author,
            source_url=args.url,
            source_format=args.source_format,
        )
        if args.json:
            print_json(book)
        else:
            print(f"Indexed {book.title} by {book.author} into {book.content_path}")
        return

    if args.command == "list-books":
        books = services["store"].list_books()
        if args.json:
            print_json(books)
        else:
            for book in books:
                print(f"- {book.id}: {book.title} by {book.author} ({book.text_length} chars)")
        return

    if args.command == "search":
        result = services["search_service"].fast_search(
            args.query,
            top_books=args.top_books,
            top_chunks=args.top_chunks,
        )
        if args.json:
            print_json(result)
        else:
            _print_search(result)
        return

    if args.command == "research":
        report = asyncio.run(
            services["orchestrator"].research(
                args.query,
                mode=ResearchMode(args.mode),
                top_books=args.top_books,
                top_chunks=args.top_chunks,
            )
        )
        if args.json:
            print_json(report)
        else:
            _print_research(report)
        return

    if args.command == "terminaluse-status":
        ready, note = services["terminaluse_runner"].availability()
        payload = {"ready": ready, "note": note}
        if args.json:
            print_json(payload)
        else:
            print(json.dumps(payload, indent=2))
        return


if __name__ == "__main__":
    main()
