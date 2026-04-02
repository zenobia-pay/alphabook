#!/usr/bin/env python3
import hashlib
import json
import os
import socket
import time
import urllib.error
import urllib.request
from pathlib import Path


BASE = Path("/root/openai-embedding-batch-full")
SUBMISSION_PATH = BASE / "submission.json"
MANIFEST_PATH = BASE / "manifest.json"
DEFAULT_SEED_STATE = Path("/root/openai-first-100-qdrant-import-state.json")
OUTPUT_DIR = Path("/root/openai-first-100-qdrant-downloads")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]
QDRANT_URL = os.environ["QDRANT_URL"].rstrip("/")
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY", "")
QDRANT_COLLECTION = os.environ["QDRANT_COLLECTION"]
RETRYABLE_HTTP = {408, 409, 425, 429, 500, 502, 503, 504}
WORKER_INDEX = int(os.environ.get("IMPORT_WORKER_INDEX", "0"))
WORKER_COUNT = int(os.environ.get("IMPORT_WORKER_COUNT", "1"))
TARGET_PARTS = int(os.environ.get("IMPORT_TARGET_PARTS", "0"))
SEED_STATE_PATH = Path(os.environ.get("IMPORT_SEED_STATE", str(DEFAULT_SEED_STATE)))
STATE_PATH = Path(os.environ.get("IMPORT_STATE_PATH", f"/root/openai-qdrant-import-state.w{WORKER_INDEX}.json"))
RUN_LOG = Path(os.environ.get("IMPORT_LOG_PATH", f"/root/openai-qdrant-import.w{WORKER_INDEX}.log"))
POLL_INTERVAL_SECONDS = int(os.environ.get("IMPORT_POLL_INTERVAL_SECONDS", "60"))
FAILED_PART_COOLDOWN_SECONDS = int(os.environ.get("FAILED_PART_COOLDOWN_SECONDS", "300"))

MANIFEST = json.loads(MANIFEST_PATH.read_text())
RUN_ID = MANIFEST["runId"]
FILES_BY_INDEX = {int(item["index"]): item for item in MANIFEST["files"]}
MAX_PART_INDEX = max(FILES_BY_INDEX)

seed_done = set()
if SEED_STATE_PATH.exists():
    try:
        seed = json.loads(SEED_STATE_PATH.read_text())
        seed_done = {int(value) for value in seed.get("done", [])}
    except Exception:
        seed_done = set()

state = {
    "done": [],
    "failed": {},
    "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "worker_index": WORKER_INDEX,
    "worker_count": WORKER_COUNT,
}
if STATE_PATH.exists():
    state = json.loads(STATE_PATH.read_text())
done = {int(value) for value in state.get("done", [])}
failed = {str(key): value for key, value in state.get("failed", {}).items()}


def save_state() -> None:
    state["done"] = sorted(done)
    state["failed"] = failed
    STATE_PATH.write_text(json.dumps(state, indent=2))


def log(message: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}"
    print(line, flush=True)
    with RUN_LOG.open("a") as handle:
        handle.write(line + "\n")


def sleep_backoff(attempt: int) -> None:
    time.sleep(min(60, 2 ** (attempt - 1)))


def record_failure(part: int, error: Exception | str) -> None:
    previous = failed.get(str(part))
    retries = 1
    if isinstance(previous, dict):
        retries = int(previous.get("retries", 0)) + 1
    failed[str(part)] = {
        "error": str(error),
        "last_failed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "retries": retries,
    }
    save_state()


def clear_failure(part: int) -> None:
    failed.pop(str(part), None)
    save_state()


def failed_cooldown_elapsed(part: int) -> bool:
    record = failed.get(str(part))
    if not isinstance(record, dict):
        return True
    last_failed_at = record.get("last_failed_at")
    if not isinstance(last_failed_at, str):
        return True
    try:
        failed_epoch = time.mktime(time.strptime(last_failed_at, "%Y-%m-%dT%H:%M:%SZ"))
    except Exception:
        return True
    return (time.time() - failed_epoch) >= FAILED_PART_COOLDOWN_SECONDS


def openai_json_request(url: str) -> dict:
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + OPENAI_API_KEY})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def fetch_completed_jobs() -> dict[int, dict]:
    url = "https://api.openai.com/v1/batches?limit=100"
    completed: dict[int, dict] = {}
    while url:
        payload = openai_json_request(url)
        for item in payload.get("data", []):
            metadata = item.get("metadata") or {}
            if metadata.get("run_id") != RUN_ID:
                continue
            part = int(metadata.get("part", "0"))
            if part not in FILES_BY_INDEX:
                continue
            if TARGET_PARTS and part > TARGET_PARTS:
                continue
            if item.get("status") != "completed" or not item.get("output_file_id"):
                continue
            completed[part] = {
                "index": part,
                "outputFileId": item["output_file_id"],
                "sidecarPath": FILES_BY_INDEX[part]["sidecarPath"],
            }
        url = None
        after = payload.get("last_id") if payload.get("has_more") else None
        if after:
            url = f"https://api.openai.com/v1/batches?limit=100&after={after}"
    return completed


def openai_get_file(file_id: str, out_path: Path) -> None:
    tmp_path = out_path.with_suffix(out_path.suffix + ".part")
    for attempt in range(1, 9):
        try:
            if tmp_path.exists():
                tmp_path.unlink()
            request = urllib.request.Request(
                f"https://api.openai.com/v1/files/{file_id}/content",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            )
            with urllib.request.urlopen(request, timeout=3600) as response, tmp_path.open("wb") as output:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
            tmp_path.replace(out_path)
            return
        except urllib.error.HTTPError as exc:
            if exc.code not in RETRYABLE_HTTP or attempt >= 8:
                raise
            log(f"download retry file_id={file_id} attempt={attempt} status={exc.code}")
            sleep_backoff(attempt)
        except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError) as exc:
            if attempt >= 8:
                raise
            log(f"download retry file_id={file_id} attempt={attempt} error={exc}")
            sleep_backoff(attempt)
    raise RuntimeError(f"failed to download {file_id}")


def qdrant_upsert(points: list[dict]) -> None:
    if not points:
        return
    body = json.dumps({"points": points}).encode("utf-8")
    for attempt in range(1, 9):
        try:
            request = urllib.request.Request(
                f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}/points?wait=true",
                data=body,
                headers={"content-type": "application/json", "api-key": QDRANT_API_KEY},
                method="PUT",
            )
            with urllib.request.urlopen(request, timeout=3600) as response:
                response.read()
            return
        except urllib.error.HTTPError as exc:
            if exc.code not in RETRYABLE_HTTP or attempt >= 8:
                raise
            log(f"qdrant retry attempt={attempt} status={exc.code} batch_size={len(points)}")
            sleep_backoff(attempt)
        except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError) as exc:
            if attempt >= 8:
                raise
            log(f"qdrant retry attempt={attempt} error={exc} batch_size={len(points)}")
            sleep_backoff(attempt)
    raise RuntimeError(f"failed to upsert batch size={len(points)}")


def to_point_id(source_id: str) -> str:
    digest = bytearray(hashlib.sha1(source_id.encode("utf-8")).digest()[:16])
    digest[6] = (digest[6] & 0x0F) | 0x50
    digest[8] = (digest[8] & 0x3F) | 0x80
    hexed = digest.hex()
    return f"{hexed[:8]}-{hexed[8:12]}-{hexed[12:16]}-{hexed[16:20]}-{hexed[20:32]}"


def should_handle_part(idx: int) -> bool:
    return (idx - 1) % WORKER_COUNT == WORKER_INDEX


def import_part(part: int, job: dict) -> None:
    sidecar_path = Path(job["sidecarPath"])
    output_path = OUTPUT_DIR / f"embedding-batch-{part:04d}-output.jsonl"
    if not output_path.exists():
        log(f"downloading part {part} file_id={job['outputFileId']}")
        openai_get_file(job["outputFileId"], output_path)
        log(f"downloaded part {part} size={output_path.stat().st_size}")
    upserted = 0
    with sidecar_path.open() as sidecar, output_path.open() as output:
        for side_line, out_line in zip(sidecar, output):
            metas = json.loads(side_line)
            out = json.loads(out_line)
            data = out["response"]["body"]["data"]
            if len(metas) != len(data):
                raise RuntimeError(f"length mismatch part {part}: {len(metas)} vs {len(data)}")
            batch = []
            for meta, item in zip(metas, data):
                source_id = meta["sourceId"]
                batch.append({
                    "id": to_point_id(source_id),
                    "vector": item["embedding"],
                    "payload": {
                        "source_id": source_id,
                        "gutenberg_id": meta.get("gutenbergId"),
                        "chunk_index": meta.get("chunkIndex"),
                        "title": meta.get("title"),
                        "authors": meta.get("authors"),
                        "language": meta.get("language"),
                        "rights_status": meta.get("rightsStatus"),
                    },
                })
                if len(batch) >= 128:
                    qdrant_upsert(batch)
                    upserted += len(batch)
                    batch = []
            if batch:
                qdrant_upsert(batch)
                upserted += len(batch)
    done.add(part)
    clear_failure(part)
    save_state()
    log(f"imported part {part} upserted={upserted}")


def target_complete(done_set: set[int]) -> bool:
    target_max = TARGET_PARTS if TARGET_PARTS else MAX_PART_INDEX
    for idx in range(1, target_max + 1):
        if not should_handle_part(idx):
            continue
        if idx in seed_done or idx in done_set:
            continue
        return False
    return True


log(
    f"start worker={WORKER_INDEX}/{WORKER_COUNT} "
    f"target_parts={TARGET_PARTS or MAX_PART_INDEX} seed_done={len(seed_done)}"
)

while True:
    completed_jobs = fetch_completed_jobs()
    progressed = False
    for part in sorted(completed_jobs):
        if not should_handle_part(part):
            continue
        if TARGET_PARTS and part > TARGET_PARTS:
            continue
        if part in seed_done or part in done:
            continue
        if str(part) in failed and not failed_cooldown_elapsed(part):
            continue
        try:
            import_part(part, completed_jobs[part])
            progressed = True
        except Exception as exc:
            record_failure(part, exc)
            log(f"failed part {part}: {exc}")
            continue
    if target_complete(done):
        log("import complete")
        break
    if not progressed:
        log("no new completed parts available; sleeping")
        time.sleep(POLL_INTERVAL_SECONDS)
