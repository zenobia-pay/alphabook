from __future__ import annotations

import argparse
import asyncio
import json
import os
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional
from uuid import uuid4

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .catalogue import SEED_BOOKS
from .cli import build_services, to_jsonable
from .models import ResearchMode


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AgentJobRequest(BaseModel):
    query: str = Field(min_length=1)
    mode: str = Field(default="slow")
    book_id: Optional[str] = None
    top_books: int = Field(default=1, ge=1, le=8)
    top_chunks: int = Field(default=8, ge=1, le=24)


@dataclass
class AgentJob:
    id: str
    query: str
    mode: str
    book_id: Optional[str]
    status: str
    created_at: str
    updated_at: str
    result: Optional[dict] = None
    error: Optional[str] = None


class AgentJobStore:
    def __init__(self, root_dir: Path):
        self.root_dir = root_dir
        self.services = build_services(root_dir)
        self.settings = self.services["settings"]
        self.jobs_dir = self.settings.cache_dir / "agent-jobs"
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._jobs: Dict[str, AgentJob] = {}
        self._ensure_seed()

    def _ensure_seed(self) -> None:
        if self.services["store"].list_books():
            return
        if "don-quixote" in SEED_BOOKS:
            self.services["pipeline"].ingest_seed("don-quixote")

    def _job_path(self, job_id: str) -> Path:
        return self.jobs_dir / f"{job_id}.json"

    def _persist(self, job: AgentJob) -> None:
        self._job_path(job.id).write_text(json.dumps(to_jsonable(job.__dict__), indent=2), encoding="utf-8")

    def create_job(self, request: AgentJobRequest) -> AgentJob:
        mode = request.mode if request.mode in {"slow", "naive"} else "slow"
        job = AgentJob(
            id=str(uuid4()),
            query=request.query.strip(),
            mode=mode,
            book_id=request.book_id,
            status="queued",
            created_at=utc_now(),
            updated_at=utc_now(),
        )
        with self._lock:
            self._jobs[job.id] = job
            self._persist(job)
        threading.Thread(
            target=self._run_job,
            args=(job.id, request.top_books, request.top_chunks),
            daemon=True,
        ).start()
        return job

    def get_job(self, job_id: str) -> AgentJob:
        with self._lock:
            if job_id in self._jobs:
                return self._jobs[job_id]
        path = self._job_path(job_id)
        if not path.exists():
            raise KeyError(job_id)
        payload = json.loads(path.read_text(encoding="utf-8"))
        job = AgentJob(**payload)
        with self._lock:
            self._jobs[job.id] = job
        return job

    def _get_existing_job(self, job_id: str) -> AgentJob:
        if job_id in self._jobs:
            return self._jobs[job_id]
        path = self._job_path(job_id)
        if not path.exists():
            raise KeyError(job_id)
        job = AgentJob(**json.loads(path.read_text(encoding="utf-8")))
        self._jobs[job.id] = job
        return job

    def _update_job(self, job_id: str, **changes: Any) -> AgentJob:
        with self._lock:
            job = self._get_existing_job(job_id)
            updated = AgentJob(
                id=job.id,
                query=changes.get("query", job.query),
                mode=changes.get("mode", job.mode),
                book_id=changes.get("book_id", job.book_id),
                status=changes.get("status", job.status),
                created_at=job.created_at,
                updated_at=utc_now(),
                result=changes.get("result", job.result),
                error=changes.get("error", job.error),
            )
            self._jobs[job_id] = updated
            self._persist(updated)
            return updated

    def _run_job(self, job_id: str, top_books: int, top_chunks: int) -> None:
        job = self._update_job(job_id, status="running")
        try:
            report = asyncio.run(
                self.services["orchestrator"].research(
                    job.query,
                    mode=ResearchMode(job.mode),
                    top_books=top_books,
                    top_chunks=top_chunks,
                )
            )
            self._update_job(job_id, status="completed", result=to_jsonable(report))
        except Exception as exc:
            self._update_job(job_id, status="failed", error=str(exc))

    def health(self) -> dict:
        codex_ready, codex_note = self.services["codex_runner"].availability()
        terminaluse_ready, terminaluse_note = self.services["terminaluse_runner"].availability()
        return {
            "status": "ok",
            "codex": {"ready": codex_ready, "note": codex_note},
            "terminaluse": {"ready": terminaluse_ready, "note": terminaluse_note},
            "books": [book.id for book in self.services["store"].list_books()],
        }


def build_auth_dependency() -> callable:
    expected = os.environ.get("ALPHABOOK_AGENT_API_TOKEN")

    def require_auth(authorization: Optional[str] = Header(default=None)) -> None:
        if not expected:
            return
        if authorization != f"Bearer {expected}":
            raise HTTPException(status_code=401, detail="Unauthorized")

    return require_auth


def create_app(root_dir: Optional[Path] = None) -> FastAPI:
    store = AgentJobStore(Path(root_dir or Path.cwd()).resolve())
    require_auth = build_auth_dependency()
    app = FastAPI(title="alphabook-agent-server")

    @app.get("/health")
    def health(_: None = Depends(require_auth)) -> dict:
        return store.health()

    @app.post("/jobs")
    def create_job(request: AgentJobRequest, _: None = Depends(require_auth)) -> dict:
        job = store.create_job(request)
        return job.__dict__

    @app.get("/jobs/{job_id}")
    def get_job(job_id: str, _: None = Depends(require_auth)) -> dict:
        try:
            return store.get_job(job_id).__dict__
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Job not found") from exc

    return app


def main(argv: Optional[list[str]] = None) -> None:
    parser = argparse.ArgumentParser(prog="alphabook-agent-server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9001)
    args = parser.parse_args(argv)
    uvicorn.run(create_app(), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
