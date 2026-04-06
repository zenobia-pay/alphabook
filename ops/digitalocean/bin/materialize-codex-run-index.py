#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any


PRIMARY_ARTIFACT_NAMES = [
    "manifest.json",
    "summary.json",
    "briefing.md",
    "dataset.jsonl",
    "dataset.csv",
    "citation-index.json",
    "relevant-books.jsonl",
    "relevant-books.csv",
    "excluded-books.jsonl",
    "shard-briefing.md",
    "book-summary.json",
    "quotes.jsonl",
    "consolidated-summary.json",
    "consolidated-briefing.md",
    "consolidated-citation-index.json",
    "run.log",
]


def read_json(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def stat_payload(path: Path) -> dict[str, Any] | None:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return {
        "path": str(path),
        "bytes": stat.st_size,
        "updated_at": stat.st_mtime,
    }


def collect_session_info(target_dir: Path) -> dict[str, Any]:
    codex_home = target_dir / "codex-home"
    sessions_dir = codex_home / ".codex" / "sessions"
    session_files = sorted(
        [path for path in sessions_dir.rglob("*") if path.is_file()],
        key=lambda path: path.stat().st_mtime,
    ) if sessions_dir.exists() else []
    payload: dict[str, Any] = {
        "codex_home": str(codex_home),
        "sessions_dir": str(sessions_dir),
        "session_files": [str(path) for path in session_files],
    }
    if session_files:
        payload["primary_session_file"] = str(session_files[-1])
    return payload


def collect_artifacts(target_dir: Path) -> list[dict[str, Any]]:
    artifacts_dir = target_dir / "artifacts"
    if not artifacts_dir.exists():
        return []
    artifacts: list[dict[str, Any]] = []
    for name in PRIMARY_ARTIFACT_NAMES:
        payload = stat_payload(artifacts_dir / name)
        if payload:
            payload["name"] = name
            artifacts.append(payload)
    return artifacts


def collect_openai_requests(target_dir: Path, proxy_run_ids: list[str]) -> dict[str, Any]:
    proxy_root = Path("/srv/alphabook/logs/openai-proxy")
    requests_index_path = proxy_root / "requests.jsonl"
    output_index_path = target_dir / "openai-requests.jsonl"
    output_dir = target_dir / "openai-proxy"
    output_dir.mkdir(parents=True, exist_ok=True)

    matched_records: list[dict[str, Any]] = []
    run_id_set = {value for value in proxy_run_ids if value}
    if requests_index_path.exists():
        for line in requests_index_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except Exception:
                continue
            if record.get("proxyRunId") not in run_id_set:
                continue
            matched_records.append(record)

    with output_index_path.open("w", encoding="utf-8") as handle:
        for record in matched_records:
            handle.write(json.dumps(record) + "\n")

    copied_files: list[str] = []
    total_cost = 0.0
    total_cost_known = False
    for record in matched_records:
        for key in ("requestFile", "responseFile"):
            source = record.get(key)
            if not source:
                continue
            source_path = Path(source)
            if not source_path.exists():
                continue
            destination = output_dir / source_path.name
            shutil.copy2(source_path, destination)
            copied_files.append(str(destination))
        if record.get("estimatedCostUsd") is not None:
            total_cost += float(record["estimatedCostUsd"])
            total_cost_known = True

    return {
        "proxy_root": str(proxy_root),
        "requests_index_file": str(output_index_path),
        "request_count": len(matched_records),
        "request_ids": [record.get("requestId") for record in matched_records],
        "copied_files": copied_files,
        "estimated_total_cost_usd": round(total_cost, 6) if total_cost_known else None,
    }


def build_chunk_payload(chunk_dir: Path) -> dict[str, Any]:
    status = read_json(chunk_dir / "status.json") or {}
    summary = read_json(chunk_dir / "summary.json") or {}
    job_id = status.get("job_id") if isinstance(status.get("job_id"), str) else chunk_dir.name
    openai = collect_openai_requests(chunk_dir, [job_id])
    payload = {
        "chunk_id": chunk_dir.name,
        "chunk_dir": str(chunk_dir),
        "job_id": job_id,
        "state": status.get("state"),
        "exit_code": status.get("exit_code"),
        "scope_file_count": status.get("scope_file_count"),
        "scope_total_bytes": status.get("scope_total_bytes"),
        "artifact_file_count": status.get("artifact_file_count"),
        "status_file": str(chunk_dir / "status.json"),
        "summary_file": str(chunk_dir / "summary.json"),
        "prompt_file": str(chunk_dir / "prompt.txt"),
        "session": collect_session_info(chunk_dir),
        "openai": openai,
        "artifacts": collect_artifacts(chunk_dir),
        "summary": summary,
    }
    if openai["estimated_total_cost_usd"] is not None:
        status["estimated_openai_cost_usd"] = openai["estimated_total_cost_usd"]
        (chunk_dir / "status.json").write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
    return payload


def build_consolidator_payload(consolidator_dir: Path) -> dict[str, Any] | None:
    if not consolidator_dir.exists():
        return None
    status = read_json(consolidator_dir / "status.json") or {}
    job_id = status.get("job_id") if isinstance(status.get("job_id"), str) else f"{consolidator_dir.parent.name}-consolidator"
    openai = collect_openai_requests(consolidator_dir, [job_id])
    payload = {
        "job_id": job_id,
        "consolidator_dir": str(consolidator_dir),
        "state": status.get("state"),
        "exit_code": status.get("exit_code"),
        "status_file": str(consolidator_dir / "status.json"),
        "summary_file": str(consolidator_dir / "summary.json"),
        "prompt_file": str(consolidator_dir / "prompt.txt"),
        "session": collect_session_info(consolidator_dir),
        "openai": openai,
        "artifacts": collect_artifacts(consolidator_dir),
    }
    if openai["estimated_total_cost_usd"] is not None:
        status["estimated_openai_cost_usd"] = openai["estimated_total_cost_usd"]
        (consolidator_dir / "status.json").write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
    return payload


def build_book_payload(book_dir: Path) -> dict[str, Any]:
    status = read_json(book_dir / "status.json") or {}
    summary = read_json(book_dir / "summary.json") or {}
    job_id = status.get("job_id") if isinstance(status.get("job_id"), str) else book_dir.name
    openai = collect_openai_requests(book_dir, [job_id])
    payload = {
        "book_id": book_dir.name,
        "book_dir": str(book_dir),
        "job_id": job_id,
        "state": status.get("state"),
        "exit_code": status.get("exit_code"),
        "artifact_file_count": status.get("artifact_file_count"),
        "status_file": str(book_dir / "status.json"),
        "summary_file": str(book_dir / "summary.json"),
        "prompt_file": str(book_dir / "prompt.txt"),
        "session": collect_session_info(book_dir),
        "openai": openai,
        "artifacts": collect_artifacts(book_dir),
        "summary": summary,
    }
    if openai["estimated_total_cost_usd"] is not None:
        status["estimated_openai_cost_usd"] = openai["estimated_total_cost_usd"]
        (book_dir / "status.json").write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    args = parser.parse_args()

    run_dir = Path(args.run_dir)
    state = read_json(run_dir / "status.json") or {}
    summary = read_json(run_dir / "summary.json") or {}

    chunks_dir = run_dir / "chunks"
    chunk_payloads = [build_chunk_payload(path) for path in sorted(chunks_dir.glob("chunk-*")) if path.is_dir()]
    books_dir = run_dir / "books"
    book_payloads = [build_book_payload(path) for path in sorted(books_dir.glob("book-*")) if path.is_dir()]
    consolidator_payload = build_consolidator_payload(run_dir / "consolidator")

    completed_chunks = sum(1 for item in chunk_payloads if item.get("state") == "completed")
    failed_chunks = sum(1 for item in chunk_payloads if item.get("state") == "failed")
    running_chunks = sum(1 for item in chunk_payloads if item.get("state") == "running")
    completed_books = sum(1 for item in book_payloads if item.get("state") == "completed")
    failed_books = sum(1 for item in book_payloads if item.get("state") == "failed")
    running_books = sum(1 for item in book_payloads if item.get("state") == "running")

    total_cost = 0.0
    total_cost_known = False
    for item in chunk_payloads:
        cost = item["openai"].get("estimated_total_cost_usd")
        if cost is not None:
            total_cost += float(cost)
            total_cost_known = True
    for item in book_payloads:
        cost = item["openai"].get("estimated_total_cost_usd")
        if cost is not None:
            total_cost += float(cost)
            total_cost_known = True
    if consolidator_payload:
        cost = consolidator_payload["openai"].get("estimated_total_cost_usd")
        if cost is not None:
            total_cost += float(cost)
            total_cost_known = True

    index_payload = {
        "job_id": run_dir.name,
        "run_dir": str(run_dir),
        "status_file": str(run_dir / "status.json"),
        "summary_file": str(run_dir / "summary.json"),
        "prompt_file": str(run_dir / "prompt.txt"),
        "wrapper_state": state.get("state"),
        "wrapper_pid": state.get("pid"),
        "launched_at": state.get("launched_at"),
        "started_at": state.get("started_at"),
        "finished_at": state.get("finished_at"),
        "model": state.get("model"),
        "chunk_size": state.get("chunk_size"),
        "max_parallel": state.get("max_parallel"),
        "user_prompt": state.get("user_prompt"),
        "chunk_count": len(chunk_payloads),
        "completed_chunks": completed_chunks,
        "failed_chunks": failed_chunks,
        "running_chunks": running_chunks,
        "chunks": chunk_payloads,
        "book_count": len(book_payloads),
        "completed_books": completed_books,
        "failed_books": failed_books,
        "running_books": running_books,
        "books": book_payloads,
        "consolidator": consolidator_payload,
        "estimated_total_openai_cost_usd": round(total_cost, 6) if total_cost_known else None,
        "wrapper_artifacts": {
            "launcher_log": stat_payload(run_dir / "launcher.log"),
            "stdout_log": stat_payload(run_dir / "manager.stdout.log"),
            "stderr_log": stat_payload(run_dir / "manager.stderr.log"),
            "heartbeat_log": stat_payload(run_dir / "heartbeat.log"),
            "process_log": stat_payload(run_dir / "process.log"),
            "partitions_manifest": stat_payload(run_dir / "state" / "partitions.json"),
            "pricing_summary": stat_payload(run_dir / "pricing-summary.json"),
        },
    }

    pricing_payload = {
        "job_id": run_dir.name,
        "estimated_total_openai_cost_usd": index_payload["estimated_total_openai_cost_usd"],
        "chunks": [
            {
                "chunk_id": item["chunk_id"],
                "job_id": item["job_id"],
                "estimated_openai_cost_usd": item["openai"].get("estimated_total_cost_usd"),
                "request_count": item["openai"].get("request_count"),
            }
            for item in chunk_payloads
        ],
        "books": [
            {
                "book_id": item["book_id"],
                "job_id": item["job_id"],
                "estimated_openai_cost_usd": item["openai"].get("estimated_total_cost_usd"),
                "request_count": item["openai"].get("request_count"),
            }
            for item in book_payloads
        ],
        "consolidator": None if not consolidator_payload else {
            "job_id": consolidator_payload["job_id"],
            "estimated_openai_cost_usd": consolidator_payload["openai"].get("estimated_total_cost_usd"),
            "request_count": consolidator_payload["openai"].get("request_count"),
        },
    }

    (run_dir / "index.json").write_text(json.dumps(index_payload, indent=2) + "\n", encoding="utf-8")
    (run_dir / "pricing-summary.json").write_text(json.dumps(pricing_payload, indent=2) + "\n", encoding="utf-8")

    state["chunk_count"] = len(chunk_payloads)
    state["completed_chunks"] = completed_chunks
    state["failed_chunks"] = failed_chunks
    state["running_chunks"] = running_chunks
    state["book_count"] = len(book_payloads)
    state["completed_books"] = completed_books
    state["failed_books"] = failed_books
    state["running_books"] = running_books
    if total_cost_known:
        state["estimated_openai_cost_usd"] = round(total_cost, 6)
    (run_dir / "status.json").write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

    if summary:
        summary["chunk_count"] = len(chunk_payloads)
        summary["completed_chunks"] = completed_chunks
        summary["failed_chunks"] = failed_chunks
        summary["book_count"] = len(book_payloads)
        summary["completed_books"] = completed_books
        summary["failed_books"] = failed_books
        if total_cost_known:
            summary["estimated_openai_cost_usd"] = round(total_cost, 6)
        (run_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
