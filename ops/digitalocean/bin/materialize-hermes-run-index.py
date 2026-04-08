#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any


PRIMARY_INNER_ARTIFACTS = [
    "manifest.json",
    "scope-report.json",
    "experiment-plan.md",
    "results.json",
    "final-answer.md",
    "final-answer.json",
    "briefing.md",
    "dataset.jsonl",
    "dataset.csv",
    "citation-index.json",
    "labels.jsonl",
    "cost-profile.json",
    "status.json",
    "run.log",
    "stream.log",
    "evidence/index.json",
]


def read_json(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text())
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


def infer_inner_run_dir(run_dir: Path) -> Path | None:
    explicit_path = run_dir / "inner-run-dir.txt"
    try:
        value = explicit_path.read_text().strip()
    except Exception:
        value = ""
    if value:
        candidate = Path(value)
        if candidate.exists():
            return candidate
    for candidate_file in ("index.json", "status.json", "summary.json"):
        payload = read_json(run_dir / candidate_file)
        if not isinstance(payload, dict):
            continue
        value = payload.get("inner_run_dir")
        if isinstance(value, str) and value.strip():
            candidate = Path(value.strip())
            if candidate.is_dir():
                return candidate
    try:
        import re
        text = (run_dir / "hermes.stdout.log").read_text(errors="ignore")
        matches = re.findall(r"/srv/alphabook/logs/corpus-(?:search|research)/[^\s\"'`]+", text)
        for value in reversed(matches):
            candidate = Path(value)
            if candidate.is_dir():
                return candidate
    except Exception:
        pass
    return None


def infer_wrapper_pid(run_dir: Path) -> int | None:
    try:
        value = (run_dir / "hermes.pid").read_text().strip()
    except Exception:
        return None
    if not value.isdigit():
        return None
    return int(value)


def collect_session_info(run_dir: Path) -> dict[str, Any]:
    hermes_home = (run_dir / "hermes-home").resolve() if (run_dir / "hermes-home").exists() else run_dir / "hermes-home"
    sessions_dir = hermes_home / ".hermes" / "sessions"
    session_files = sorted(sessions_dir.glob("session_*.json"), key=lambda p: p.stat().st_mtime)
    payload: dict[str, Any] = {
        "hermes_home": str(hermes_home),
        "sessions_dir": str(sessions_dir),
    }
    if session_files:
        latest = session_files[-1]
        payload["primary_session_file"] = str(latest)
        session_id = latest.stem.removeprefix("session_")
        payload["primary_session_id"] = session_id
        snapshot_path = run_dir / "hermes.session.json"
        shutil.copy2(latest, snapshot_path)
        payload["session_snapshot_file"] = str(snapshot_path)
    return payload


def collect_openai_requests(run_dir: Path, job_ids: list[str]) -> dict[str, Any]:
    proxy_root = Path("/srv/alphabook/logs/openai-proxy")
    requests_index_path = proxy_root / "requests.jsonl"
    output_index_path = run_dir / "openai-requests.jsonl"
    output_dir = run_dir / "openai-proxy"
    output_dir.mkdir(parents=True, exist_ok=True)

    matched_records: list[dict[str, Any]] = []
    job_id_set = {value for value in job_ids if value}
    if requests_index_path.exists():
        for line in requests_index_path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except Exception:
                continue
            if record.get("proxyRunId") not in job_id_set:
                continue
            matched_records.append(record)

    with output_index_path.open("w") as handle:
        for record in matched_records:
            handle.write(json.dumps(record) + "\n")

    copied_files = []
    total_cost = 0.0
    total_cost_known = False
    prompt_tokens = 0
    completion_tokens = 0
    total_tokens = 0
    cached_input_tokens = 0
    for record in matched_records:
        for key in ("requestFile", "responseFile"):
            source = record.get(key)
            if not source:
                continue
            source_path = Path(source)
            if not source_path.exists():
                continue
            dest = output_dir / source_path.name
            shutil.copy2(source_path, dest)
            copied_files.append(str(dest))
        if record.get("estimatedCostUsd") is not None:
            total_cost += float(record["estimatedCostUsd"])
            total_cost_known = True
        usage = record.get("usage")
        if isinstance(usage, dict):
            prompt = usage.get("prompt_tokens", usage.get("input_tokens", 0))
            completion = usage.get("completion_tokens", usage.get("output_tokens", 0))
            total = usage.get("total_tokens", None)
            prompt_details = usage.get("prompt_tokens_details")
            cached = 0
            if isinstance(prompt_details, dict):
                cached = prompt_details.get("cached_tokens", 0)
            try:
                prompt_tokens += int(prompt or 0)
            except Exception:
                pass
            try:
                completion_tokens += int(completion or 0)
            except Exception:
                pass
            try:
                cached_input_tokens += int(cached or 0)
            except Exception:
                pass
            try:
                total_tokens += int(total if total is not None else (int(prompt or 0) + int(completion or 0)))
            except Exception:
                pass

    return {
        "proxy_root": str(proxy_root),
        "requests_index_file": str(output_index_path),
        "request_count": len(matched_records),
        "request_ids": [record["requestId"] for record in matched_records],
        "copied_files": copied_files,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "cached_input_tokens": cached_input_tokens,
        "estimated_total_cost_usd": round(total_cost, 6) if total_cost_known else None,
    }


def collect_inner_artifacts(inner_run_dir: Path | None) -> list[dict[str, Any]]:
    if inner_run_dir is None:
        return []
    artifacts = []
    for name in PRIMARY_INNER_ARTIFACTS:
        payload = stat_payload(inner_run_dir / name)
        if payload:
            payload["name"] = name
            artifacts.append(payload)
    return artifacts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    args = parser.parse_args()

    run_dir = Path(args.run_dir)
    job_id = run_dir.name
    status = read_json(run_dir / "status.json") or {}
    summary = read_json(run_dir / "summary.json") or {}

    inner_run_dir = infer_inner_run_dir(run_dir)
    inner_manifest = read_json(inner_run_dir / "manifest.json") if inner_run_dir else None
    inner_status = read_json(inner_run_dir / "status.json") if inner_run_dir else None

    session_info = collect_session_info(run_dir)
    openai_info = collect_openai_requests(run_dir, [job_id, f"{job_id}-synthesis"])
    canonical_hermes_session_id = session_info.get("primary_session_id")
    archive_prefix = status.get("archive_prefix") if isinstance(status.get("archive_prefix"), str) else summary.get("archive_prefix")
    bridge_payload = {
        "externalJobId": job_id,
        "wrapperRunDir": str(run_dir),
        "innerRunDir": str(inner_run_dir) if inner_run_dir else None,
        "innerRunId": inner_run_dir.name if inner_run_dir else None,
        "archivePrefix": archive_prefix if isinstance(archive_prefix, str) else None,
        "hermesSessionId": canonical_hermes_session_id if isinstance(canonical_hermes_session_id, str) else None,
        "alphabookSessionId": status.get("alphabook_session_id") if isinstance(status.get("alphabook_session_id"), str) else None,
        "alphabookRunId": status.get("alphabook_run_id") if isinstance(status.get("alphabook_run_id"), str) else None,
    }
    bridge_file = run_dir / "bridge.json"
    bridge_file.write_text(json.dumps(bridge_payload, indent=2) + "\n")

    index_payload = {
        "job_id": job_id,
        "run_dir": str(run_dir),
        "bridge_file": str(bridge_file),
        "bridge": bridge_payload,
        "status_file": str(run_dir / "status.json"),
        "summary_file": str(run_dir / "summary.json"),
        "prompt_file": str(run_dir / "prompt.txt"),
        "wrapper_state": status.get("state"),
        "wrapper_pid": status.get("pid") if isinstance(status.get("pid"), int) else infer_wrapper_pid(run_dir),
        "launched_at": status.get("launched_at"),
        "started_at": status.get("started_at"),
        "finished_at": status.get("finished_at"),
        "model": status.get("model"),
        "max_turns": status.get("max_turns"),
        "user_prompt": status.get("user_prompt"),
        "inner_run_dir": str(inner_run_dir) if inner_run_dir else None,
        "inner_run_id": inner_run_dir.name if inner_run_dir else None,
        "inner_manifest_status": inner_manifest.get("status") if inner_manifest else None,
        "inner_phase": inner_status.get("phase") if inner_status else None,
        "inner_record_counts": inner_manifest.get("record_counts") if inner_manifest else None,
        "session": session_info,
        "openai": openai_info,
        "wrapper_artifacts": {
            "launcher_log": stat_payload(run_dir / "launcher.log"),
            "stdout_log": stat_payload(run_dir / "hermes.stdout.log"),
            "stderr_log": stat_payload(run_dir / "hermes.stderr.log"),
            "heartbeat_log": stat_payload(run_dir / "heartbeat.log"),
            "process_log": stat_payload(run_dir / "process.log"),
            "profile_jsonl": stat_payload(run_dir / "profile.jsonl"),
            "command_snapshots_jsonl": stat_payload(run_dir / "command-snapshots.jsonl"),
            "inner_run_file": stat_payload(run_dir / "inner-run-dir.txt"),
        },
        "inner_artifacts": collect_inner_artifacts(inner_run_dir),
    }

    (run_dir / "index.json").write_text(json.dumps(index_payload, indent=2) + "\n")

    status["job_id"] = job_id
    if isinstance(status.get("pid"), int):
        pid = status["pid"]
    else:
        pid = infer_wrapper_pid(run_dir)
        if pid is not None:
            status["pid"] = pid
    status["inner_run_dir"] = str(inner_run_dir) if inner_run_dir else None
    status["inner_run_id"] = inner_run_dir.name if inner_run_dir else None
    status["hermes_session_id"] = bridge_payload["hermesSessionId"]
    status["hermes_session_file"] = session_info.get("session_snapshot_file") or session_info.get("primary_session_file")
    status["bridge_file"] = str(bridge_file)
    status["openai_requests_file"] = openai_info["requests_index_file"]
    status["openai_request_count"] = openai_info["request_count"]
    if openai_info["estimated_total_cost_usd"] is not None:
        status["estimated_openai_cost_usd"] = openai_info["estimated_total_cost_usd"]
    (run_dir / "status.json").write_text(json.dumps(status, indent=2) + "\n")
    if summary:
        summary.update(
            {
                "job_id": job_id,
                "pid": status.get("pid"),
                "inner_run_dir": status["inner_run_dir"],
                "inner_run_id": status["inner_run_id"],
                "hermes_session_id": status["hermes_session_id"],
                "openai_request_count": status["openai_request_count"],
            }
        )
        (run_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")


if __name__ == "__main__":
    main()
