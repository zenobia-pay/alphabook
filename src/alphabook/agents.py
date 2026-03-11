from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from .config import Settings
from .embeddings import BaseEmbeddingProvider, cosine_similarity
from .models import BookAgentResult, BookRecord, Evidence, SearchHit
from .search import score_text_query
from .storage import CorpusStore
from .text import make_excerpt, slugify


def _extract_json_payload(raw_output: str) -> Optional[object]:
    lines = [line.strip() for line in raw_output.splitlines() if line.strip()]
    for line in reversed(lines):
        if line.startswith("{") or line.startswith("["):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    return None


def build_terminaluse_prompt(query: str, book: BookRecord, hints: Sequence[SearchHit]) -> str:
    hint_lines = []
    for hint in hints[:8]:
        hint_lines.append(
            f"- chunk {hint.chunk.chunk_index} ({hint.strategy}, score={hint.score:.3f}): {hint.excerpt}"
        )

    hints_block = "\n".join(hint_lines) if hint_lines else "- no hints supplied"
    return (
        "You are a book research agent.\n\n"
        f"Book: {book.title} by {book.author}\n"
        f"Query: {query}\n\n"
        "Workspace contract:\n"
        "- read input/book.txt for the full text\n"
        "- read input/manifest.json for metadata\n"
        "- read input/hints.json for candidate passages from the fast pass\n"
        "- write the final answer to output/report.md\n"
        "- optionally write output/report.json\n\n"
        "Use shell tools such as rg, sed, and small scripts to inspect the full text. Focus on exact evidence.\n\n"
        "Fast-pass hints:\n"
        f"{hints_block}\n"
    )


def build_codex_prompt(query: str, book: BookRecord, hints: Sequence[SearchHit]) -> str:
    hint_lines = []
    for hint in hints[:8]:
        hint_lines.append(
            f"- chunk {hint.chunk.chunk_index} ({hint.strategy}, score={hint.score:.3f}): {hint.excerpt}"
        )

    hints_block = "\n".join(hint_lines) if hint_lines else "- no hints supplied"
    return (
        "You are a book research agent running inside a disposable workspace.\n\n"
        f"Book: {book.title} by {book.author}\n"
        f"Query: {query}\n\n"
        "Read these files:\n"
        "- input/book.txt for the full book text\n"
        "- input/manifest.json for metadata\n"
        "- input/hints.json for top passages from the fast retrieval pass\n\n"
        "Use shell tools like rg, sed, and small scripts to search the book.\n"
        "Then write two files:\n"
        "- output/report.md: a concise markdown research note\n"
        "- output/report.json: JSON with this shape:\n"
        '  {"summary": string, "evidence": [{"chunk_index": number, "reason": string, "excerpt": string}]}\n\n'
        "Focus on grounded evidence. If evidence is weak, say so clearly.\n\n"
        "Fast-pass hints:\n"
        f"{hints_block}\n"
    )


class LocalBookAgentRunner:
    def __init__(self, store: CorpusStore, embedder: BaseEmbeddingProvider):
        self.store = store
        self.embedder = embedder
        self.name = "local-deep-scan"

    async def run_many(
        self,
        query: str,
        books: Sequence[BookRecord],
        hints_by_book: Dict[str, Sequence[SearchHit]],
    ) -> List[BookAgentResult]:
        tasks = [self.run_book(query, book, hints_by_book.get(book.id, [])) for book in books]
        return await asyncio.gather(*tasks)

    async def run_book(self, query: str, book: BookRecord, hints: Sequence[SearchHit]) -> BookAgentResult:
        return await asyncio.to_thread(self._run_sync, query, book, hints)

    def _run_sync(self, query: str, book: BookRecord, hints: Sequence[SearchHit]) -> BookAgentResult:
        chunks = self.store.list_chunks(book.id)
        vectors = self.store.get_embeddings("chunk", [chunk.id for chunk in chunks])
        query_vector = self.embedder.embed_texts([query])[0]
        hint_bonus = {hint.chunk.id: 0.15 for hint in hints}

        evidence: List[Evidence] = []
        for chunk in chunks:
            lexical = score_text_query(query, chunk.content)
            semantic = cosine_similarity(query_vector, vectors.get(chunk.id, []))
            score = (0.7 * semantic) + (0.3 * min(lexical, 10.0) / 10.0) + hint_bonus.get(chunk.id, 0.0)
            if score <= 0.12 and lexical <= 0:
                continue
            evidence.append(
                Evidence(
                    chunk_id=chunk.id,
                    chunk_index=chunk.chunk_index,
                    score=score,
                    strategy="local-deep-scan",
                    excerpt=make_excerpt(chunk.content, query),
                    reason=f"semantic={semantic:.3f}, lexical={lexical:.3f}, hint_bonus={hint_bonus.get(chunk.id, 0.0):.2f}",
                )
            )

        evidence.sort(key=lambda item: item.score, reverse=True)
        top_evidence = evidence[:6]

        if top_evidence:
            summary = (
                f"Found {len(top_evidence)} high-signal passages in {book.title}. "
                f"Strongest chunk indexes: {', '.join(str(item.chunk_index) for item in top_evidence[:3])}."
            )
        else:
            summary = f"No high-confidence passages found in {book.title} for this query."

        return BookAgentResult(
            book=book,
            runner=self.name,
            summary=summary,
            evidence=top_evidence,
        )


class CodexCliRunner:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.name = "codex-cli"

    def availability(self) -> Tuple[bool, str]:
        if not self.settings.enable_codex_runner:
            return False, "ALPHABOOK_ENABLE_CODEX_RUNNER is not set"
        if shutil.which(self.settings.codex_binary) is None:
            return False, f"{self.settings.codex_binary} is not installed"

        try:
            result = subprocess.run(
                [self.settings.codex_binary, "exec", "--help"],
                check=False,
                capture_output=True,
                text=True,
                timeout=20,
            )
        except Exception as exc:
            return False, f"codex exec check failed: {exc}"

        if result.returncode != 0:
            return False, "codex exec is not available"
        return True, "ready"

    async def run_many(
        self,
        query: str,
        books: Sequence[BookRecord],
        hints_by_book: Dict[str, Sequence[SearchHit]],
    ) -> List[BookAgentResult]:
        tasks = [self.run_book(query, book, hints_by_book.get(book.id, [])) for book in books]
        return await asyncio.gather(*tasks)

    async def run_book(self, query: str, book: BookRecord, hints: Sequence[SearchHit]) -> BookAgentResult:
        return await asyncio.to_thread(self._run_sync, query, book, hints)

    def _run_sync(self, query: str, book: BookRecord, hints: Sequence[SearchHit]) -> BookAgentResult:
        is_ready, reason = self.availability()
        if not is_ready:
            raise RuntimeError(reason)

        workspace = self._prepare_workspace(book, query, hints)
        output_dir = workspace / "output"
        final_output = output_dir / "final.md"
        report_json = output_dir / "report.json"
        report_md = output_dir / "report.md"

        command = [
            self.settings.codex_binary,
            "exec",
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            "-C",
            str(workspace),
            "-o",
            str(final_output),
            build_codex_prompt(query, book, hints),
        ]
        if self.settings.codex_model:
            command.extend(["-m", self.settings.codex_model])
        if self.settings.codex_profile:
            command.extend(["-p", self.settings.codex_profile])

        completed = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=1800,
        )

        evidence: List[Evidence] = []
        summary = ""

        if report_json.exists():
            try:
                payload = json.loads(report_json.read_text(encoding="utf-8"))
                summary = str(payload.get("summary") or "").strip()
                for item in payload.get("evidence", [])[:6]:
                    evidence.append(
                        Evidence(
                            chunk_id=f"{book.id}:{item.get('chunk_index', 'unknown')}",
                            chunk_index=int(item.get("chunk_index", -1)),
                            score=0.9,
                            strategy=self.name,
                            excerpt=str(item.get("excerpt") or "").strip(),
                            reason=str(item.get("reason") or "reported by codex").strip(),
                        )
                    )
            except Exception:
                summary = ""

        if not summary and report_md.exists():
            summary = report_md.read_text(encoding="utf-8").strip()
        if not summary and final_output.exists():
            summary = final_output.read_text(encoding="utf-8").strip()
        if not summary:
            summary = completed.stdout.strip() or f"Codex completed for {book.title}, but no report file was written."

        return BookAgentResult(
            book=book,
            runner=self.name,
            summary=summary,
            evidence=evidence,
            output_path=str(report_md if report_md.exists() else final_output),
        )

    def _prepare_workspace(self, book: BookRecord, query: str, hints: Sequence[SearchHit]) -> Path:
        workspace = self.settings.cache_dir / "codex-workspaces" / f"{book.id}-{slugify(query)[:48]}"
        input_dir = workspace / "input"
        output_dir = workspace / "output"
        input_dir.mkdir(parents=True, exist_ok=True)
        output_dir.mkdir(parents=True, exist_ok=True)

        source_path = Path(book.content_path)
        (input_dir / "book.txt").write_text(source_path.read_text(encoding="utf-8"), encoding="utf-8")
        (input_dir / "query.txt").write_text(query, encoding="utf-8")
        (input_dir / "manifest.json").write_text(
            json.dumps(
                {
                    "book_id": book.id,
                    "title": book.title,
                    "author": book.author,
                    "source_url": book.source_url,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        (input_dir / "hints.json").write_text(
            json.dumps(
                [
                    {
                        "chunk_index": hint.chunk.chunk_index,
                        "strategy": hint.strategy,
                        "score": round(hint.score, 4),
                        "excerpt": hint.excerpt,
                    }
                    for hint in hints[:12]
                ],
                indent=2,
            ),
            encoding="utf-8",
        )
        return workspace


class TerminalUseCliRunner:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.name = "terminaluse-cli"

    def availability(self) -> Tuple[bool, str]:
        if shutil.which("tu") is None:
            return False, "tu CLI is not installed"
        if not self.settings.terminaluse_project_id:
            return False, "ALPHABOOK_TERMINALUSE_PROJECT_ID is not set"
        if not self.settings.terminaluse_agent_name:
            return False, "ALPHABOOK_TERMINALUSE_AGENT_NAME is not set"

        try:
            result = subprocess.run(
                ["tu", "whoami", "--json"],
                check=False,
                capture_output=True,
                text=True,
                timeout=20,
            )
        except Exception as exc:
            return False, f"tu whoami failed: {exc}"

        payload = _extract_json_payload(result.stdout)
        if not isinstance(payload, dict):
            return False, "could not parse tu whoami output"
        if not payload.get("authenticated"):
            return False, "tu is not authenticated"
        if payload.get("expired"):
            return False, "tu authentication is expired; run 'tu login'"
        return True, "ready"

    async def run_many(
        self,
        query: str,
        books: Sequence[BookRecord],
        hints_by_book: Dict[str, Sequence[SearchHit]],
    ) -> List[BookAgentResult]:
        tasks = [self.run_book(query, book, hints_by_book.get(book.id, [])) for book in books]
        return await asyncio.gather(*tasks)

    async def run_book(self, query: str, book: BookRecord, hints: Sequence[SearchHit]) -> BookAgentResult:
        return await asyncio.to_thread(self._run_sync, query, book, hints)

    def _run_sync(self, query: str, book: BookRecord, hints: Sequence[SearchHit]) -> BookAgentResult:
        is_ready, reason = self.availability()
        if not is_ready:
            raise RuntimeError(reason)

        workspace = self._prepare_workspace(book, query, hints)
        filesystem = self._run_json(
            [
                "tu",
                "fs",
                "create",
                "--project-id",
                self.settings.terminaluse_project_id or "",
                "--dir",
                str(workspace),
                "--name",
                f"{book.id}-{slugify(query)[:32]}",
                "--json",
            ]
        )
        filesystem_id = self._pick_id(filesystem)
        if not filesystem_id:
            raise RuntimeError("Could not determine filesystem ID from 'tu fs create'")

        task_cmd = [
            "tu",
            "tasks",
            "create",
            "--filesystem-id",
            filesystem_id,
            "--agent",
            self.settings.terminaluse_agent_name or "",
            "--name",
            f"{book.id}-{slugify(query)[:32]}",
            "--json",
        ]
        if self.settings.terminaluse_branch:
            task_cmd.extend(["--branch", self.settings.terminaluse_branch])
        task = self._run_json(task_cmd)
        task_id = self._pick_id(task)
        if not task_id:
            raise RuntimeError("Could not determine task ID from 'tu tasks create'")

        subprocess.run(
            ["tu", "tasks", "send", task_id, "--message", build_terminaluse_prompt(query, book, hints), "--json"],
            check=True,
            capture_output=True,
            text=True,
            timeout=900,
        )

        output_dir = self.settings.cache_dir / "terminaluse-output" / task_id
        output_dir.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["tu", "tasks", "pull", task_id, "--out", str(output_dir)],
            check=True,
            capture_output=True,
            text=True,
            timeout=300,
        )

        report_path = output_dir / "output" / "report.md"
        summary = report_path.read_text(encoding="utf-8").strip() if report_path.exists() else (
            f"Terminal Use task {task_id} completed for {book.title}, but no output/report.md was found."
        )

        return BookAgentResult(
            book=book,
            runner=self.name,
            summary=summary,
            evidence=[],
            task_id=task_id,
            output_path=str(report_path) if report_path.exists() else str(output_dir),
        )

    def _prepare_workspace(self, book: BookRecord, query: str, hints: Sequence[SearchHit]) -> Path:
        workspace = self.settings.cache_dir / "terminaluse-workspaces" / f"{book.id}-{slugify(query)[:48]}"
        input_dir = workspace / "input"
        output_dir = workspace / "output"
        input_dir.mkdir(parents=True, exist_ok=True)
        output_dir.mkdir(parents=True, exist_ok=True)

        source_path = Path(book.content_path)
        (input_dir / "book.txt").write_text(source_path.read_text(encoding="utf-8"), encoding="utf-8")
        (input_dir / "query.txt").write_text(query, encoding="utf-8")
        (input_dir / "manifest.json").write_text(
            json.dumps(
                {
                    "book_id": book.id,
                    "title": book.title,
                    "author": book.author,
                    "source_url": book.source_url,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        (input_dir / "hints.json").write_text(
            json.dumps(
                [
                    {
                        "chunk_index": hint.chunk.chunk_index,
                        "strategy": hint.strategy,
                        "score": hint.score,
                        "excerpt": hint.excerpt,
                    }
                    for hint in hints[:8]
                ],
                indent=2,
            ),
            encoding="utf-8",
        )
        (input_dir / "instructions.md").write_text(build_terminaluse_prompt(query, book, hints), encoding="utf-8")
        return workspace

    def _run_json(self, cmd: Sequence[str]) -> object:
        result = subprocess.run(
            list(cmd),
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
        )
        payload = _extract_json_payload(result.stdout)
        if payload is None:
            raise RuntimeError(f"Could not parse JSON from command: {' '.join(cmd)}")
        return payload

    @staticmethod
    def _pick_id(payload: object) -> Optional[str]:
        if isinstance(payload, dict):
            for key in ("id", "task_id", "filesystem_id"):
                value = payload.get(key)
                if isinstance(value, str):
                    return value
            for nested_key in ("task", "filesystem", "data"):
                nested = payload.get(nested_key)
                picked = TerminalUseCliRunner._pick_id(nested)
                if picked:
                    return picked
        return None
