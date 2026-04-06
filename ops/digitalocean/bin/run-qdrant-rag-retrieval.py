#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import urllib.error
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_EMBEDDING_MODEL = os.environ.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
DEFAULT_EMBEDDING_DIMENSIONS = int(os.environ.get("OPENAI_EMBEDDING_DIMENSIONS", "768"))
DEFAULT_EXPANSION_MODEL = os.environ.get("ALPHABOOK_RAG_EXPANSION_MODEL", "gpt-5-mini")
DEFAULT_RERANK_MODEL = os.environ.get("ALPHABOOK_RAG_RERANK_MODEL", "gpt-5-mini")


@dataclass
class MetadataRow:
    gutenberg_id: str
    title: str | None
    author: str | None
    clean_path: str | None
    corpus_chunk_id: str | None


@dataclass
class ChunkHit:
    gutenberg_id: str
    source_id: str
    chunk_index: int
    score: float
    variant: str
    title: str | None
    authors: list[str]
    corpus_chunk_id: str | None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run bounded Qdrant-first RAG retrieval with query expansion, packet grouping, and optional reranking.",
    )
    parser.add_argument("--query", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--precomputed-index-dir", default=os.environ.get("PRECOMPUTED_INDEX_DIR"))
    parser.add_argument("--scope-file")
    parser.add_argument("--gutenberg-id", action="append", default=[])
    parser.add_argument("--gutenberg-ids-file")
    parser.add_argument("--corpus-chunk-id")
    parser.add_argument("--chunk-map-path", default=os.environ.get("CORPUS_VECTOR_CHUNK_MAP_PATH"))
    parser.add_argument("--openai-base-url", default=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"))
    parser.add_argument("--openai-api-key", default=os.environ.get("OPENAI_API_KEY"))
    parser.add_argument("--qdrant-url", default=os.environ.get("QDRANT_URL"))
    parser.add_argument("--qdrant-api-key", default=os.environ.get("QDRANT_API_KEY"))
    parser.add_argument("--collection", default=os.environ.get("QDRANT_COLLECTION"))
    parser.add_argument("--embedding-model", default=DEFAULT_EMBEDDING_MODEL)
    parser.add_argument("--embedding-dimensions", type=int, default=DEFAULT_EMBEDDING_DIMENSIONS)
    parser.add_argument("--expansion-model", default=DEFAULT_EXPANSION_MODEL)
    parser.add_argument("--rerank-model", default=DEFAULT_RERANK_MODEL)
    parser.add_argument("--variant-count", type=int, default=24)
    parser.add_argument("--vector-limit", type=int, default=64)
    parser.add_argument("--max-pages", type=int, default=8)
    parser.add_argument("--score-threshold", type=float, default=0.2)
    parser.add_argument("--chunk-target-chars", type=int, default=1400)
    parser.add_argument("--merge-gap-chunks", type=int, default=1)
    parser.add_argument("--packet-min-chars", type=int, default=800)
    parser.add_argument("--packet-max-chars", type=int, default=2000)
    parser.add_argument("--rerank-batch-size", type=int, default=12)
    parser.add_argument("--rerank-keep", type=int, default=200)
    parser.add_argument("--disable-rerank", action="store_true")
    return parser.parse_args()


def normalize_variant(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def extract_json_object(raw: str) -> str:
    text = raw.strip()
    if text.startswith("{") or text.startswith("["):
        return text
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text, re.IGNORECASE)
    if fenced:
        return fenced.group(1).strip()
    first_brace = text.find("{")
    last_brace = text.rfind("}")
    if first_brace >= 0 and last_brace > first_brace:
        return text[first_brace:last_brace + 1]
    first_bracket = text.find("[")
    last_bracket = text.rfind("]")
    if first_bracket >= 0 and last_bracket > first_bracket:
        return text[first_bracket:last_bracket + 1]
    return text


def post_json(url: str, body: dict[str, Any], *, api_key: str | None, bearer: bool) -> dict[str, Any]:
    headers = {"content-type": "application/json"}
    if api_key:
        headers["authorization" if bearer else "api-key"] = f"Bearer {api_key}" if bearer else api_key
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=300) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise SystemExit(f"{url} failed: {exc.code} {detail[:500]}") from exc


def ensure_output_dir(path: str) -> Path:
    output_dir = Path(path)
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def parse_scope_file(path: str | None) -> set[str]:
    if not path:
        return set()
    ids: set[str] = set()
    pattern = re.compile(r"/clean/(\d+)/clean\.txt$")
    for raw_line in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split("\t", 1)
        candidate = parts[-1]
        match = pattern.search(candidate)
        if match:
            ids.add(match.group(1))
    return ids


def parse_ids_file(path: str | None) -> set[str]:
    if not path:
        return set()
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        values = payload.get("gutenberg_ids") or payload.get("ids") or payload.get("rows") or []
        if isinstance(values, list):
            result: set[str] = set()
            for value in values:
                if isinstance(value, dict) and value.get("gutenberg_id"):
                    result.add(str(value["gutenberg_id"]).strip())
                elif value is not None:
                    result.add(str(value).strip())
            return {value for value in result if value}
    if isinstance(payload, list):
        return {str(value).strip() for value in payload if str(value).strip()}
    return set()


def parse_chunk_map_ids(chunk_map_path: str | None, corpus_chunk_id: str | None) -> set[str]:
    if not corpus_chunk_id or not chunk_map_path:
        return set()
    payload = json.loads(Path(chunk_map_path).read_text(encoding="utf-8"))
    rows = payload.get("rows") if isinstance(payload, dict) else []
    return {
        str(row.get("gutenberg_id")).strip()
        for row in rows
        if isinstance(row, dict) and row.get("corpus_chunk_id") == corpus_chunk_id and str(row.get("gutenberg_id", "")).strip()
    }


def parse_authors(raw_value: Any) -> list[str]:
    if isinstance(raw_value, list):
        return [str(item).strip() for item in raw_value if str(item).strip()]
    if isinstance(raw_value, str):
        text = raw_value.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()]
        except json.JSONDecodeError:
            pass
        return [text]
    return []


def load_metadata_index(index_dir: str, allowed_ids: set[str]) -> dict[str, MetadataRow]:
    metadata_path = Path(index_dir) / "metadata-table.jsonl"
    if not metadata_path.exists():
        raise SystemExit(f"Missing metadata table: {metadata_path}")
    rows: dict[str, MetadataRow] = {}
    with metadata_path.open(encoding="utf-8") as handle:
        for raw_line in handle:
            if not raw_line.strip():
                continue
            row = json.loads(raw_line)
            gutenberg_id = str(row.get("gutenberg_id", "")).strip()
            if not gutenberg_id:
                continue
            if allowed_ids and gutenberg_id not in allowed_ids:
                continue
            authors = parse_authors(row.get("authors_json"))
            rows[gutenberg_id] = MetadataRow(
                gutenberg_id=gutenberg_id,
                title=str(row.get("title")).strip() if row.get("title") is not None else None,
                author=authors[0] if authors else None,
                clean_path=str(row.get("clean_path")).strip() if row.get("clean_path") else str(row.get("primary_text_path")).strip() if row.get("primary_text_path") else None,
                corpus_chunk_id=str(row.get("corpus_chunk_id")).strip() if row.get("corpus_chunk_id") else None,
            )
    return rows


def chunk_corpus_text(text: str, target_size: int) -> list[str]:
    def split_oversized_segment(segment: str) -> list[str]:
        normalized = segment.strip()
        if not normalized:
            return []
        if len(normalized) <= target_size:
            return [normalized]
        pieces: list[str] = []
        start = 0
        while start < len(normalized):
            end = min(start + target_size, len(normalized))
            if end < len(normalized):
                newline = normalized.rfind("\n", start, end)
                whitespace_match = re.search(r"\s\S*$", normalized[start:end])
                whitespace_index = start + whitespace_match.start() if whitespace_match else -1
                if newline > start + int(target_size * 0.5):
                    end = newline
                elif whitespace_index > start:
                    end = whitespace_index
            piece = normalized[start:end].strip()
            if piece:
                pieces.append(piece)
            start = end
            while start < len(normalized) and normalized[start].isspace():
                start += 1
        return pieces

    paragraphs = [
        piece
        for paragraph in re.split(r"\n{2,}", text)
        for piece in split_oversized_segment(paragraph)
        if piece
    ]
    chunks: list[str] = []
    buffer = ""
    for paragraph in paragraphs:
        next_value = f"{buffer}\n\n{paragraph}" if buffer else paragraph
        if len(next_value) > target_size and buffer:
            chunks.append(buffer)
            buffer = paragraph
            continue
        buffer = next_value
    if buffer:
        chunks.append(buffer)
    return chunks


def expand_query_variants(args: argparse.Namespace, output_dir: Path) -> list[str]:
    if not args.openai_api_key:
        raise SystemExit("OPENAI_API_KEY is required for query expansion")
    schema = {
        "type": "json_schema",
        "json_schema": {
            "name": "rag_query_expansion",
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "required": ["variants"],
                "properties": {
                    "variants": {
                        "type": "array",
                        "minItems": max(10, min(args.variant_count, 50)),
                        "maxItems": max(10, min(args.variant_count, 50)),
                        "items": {
                            "type": "string",
                            "minLength": 3,
                        },
                    },
                },
            },
        },
    }
    prompt = "\n".join([
        "Generate semantically diverse retrieval variants for a corpus RAG pipeline.",
        "Cover synonyms, paraphrases, narrower variants, broader variants, contextual indicators, edge cases, and related phrasings.",
        "Do not number the variants.",
        "Keep them retrieval-oriented, concrete, and high recall.",
        f"Return exactly {max(10, min(args.variant_count, 50))} variants.",
        f"Original query: {args.query}",
    ])
    payload = post_json(
        f"{args.openai_base_url.rstrip('/')}/chat/completions",
        {
            "model": args.expansion_model,
            "response_format": schema,
            "messages": [
                {
                    "role": "system",
                    "content": "You produce retrieval query variants for bounded RAG jobs. Return JSON only.",
                },
                {
                    "role": "user",
                    "content": prompt,
                },
            ],
        },
        api_key=args.openai_api_key,
        bearer=True,
    )
    content = payload.get("choices", [{}])[0].get("message", {}).get("content", "")
    variants_payload = json.loads(extract_json_object(str(content)))
    variants = [normalize_variant(args.query)]
    for raw_variant in variants_payload.get("variants", []):
        variant = normalize_variant(str(raw_variant))
        if variant and variant.lower() not in {existing.lower() for existing in variants}:
            variants.append(variant)
    rendered = {
        "query": args.query,
        "expansion_model": args.expansion_model,
        "variant_count": len(variants),
        "variants": variants,
    }
    (output_dir / "query-expansion.json").write_text(json.dumps(rendered, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return variants


def embed_query(args: argparse.Namespace, query: str) -> list[float]:
    if not args.openai_api_key:
        raise SystemExit("OPENAI_API_KEY is required for embeddings")
    request: dict[str, Any] = {
        "model": args.embedding_model,
        "input": query,
    }
    if args.embedding_dimensions > 0 and args.embedding_model.startswith("text-embedding-3-"):
        request["dimensions"] = args.embedding_dimensions
    payload = post_json(
        f"{args.openai_base_url.rstrip('/')}/embeddings",
        request,
        api_key=args.openai_api_key,
        bearer=True,
    )
    data = payload.get("data") or []
    if not data or not isinstance(data[0], dict) or not isinstance(data[0].get("embedding"), list):
        raise SystemExit("Embedding response did not include a usable vector")
    return [float(value) for value in data[0]["embedding"]]


def build_qdrant_filter(args: argparse.Namespace, scoped_ids: set[str]) -> dict[str, Any] | None:
    must: list[dict[str, Any]] = []
    if args.corpus_chunk_id:
        must.append({"key": "corpus_chunk_id", "match": {"value": args.corpus_chunk_id}})
    if len(scoped_ids) == 1:
        must.append({"key": "gutenberg_id", "match": {"value": next(iter(scoped_ids))}})
    elif len(scoped_ids) > 1:
        must.append({"key": "gutenberg_id", "match": {"any": sorted(scoped_ids)}})
    return {"must": must} if must else None


def search_qdrant_variant(
    args: argparse.Namespace,
    variant: str,
    scoped_ids: set[str],
) -> list[dict[str, Any]]:
    if not args.qdrant_url or not args.collection:
        raise SystemExit("QDRANT_URL and QDRANT_COLLECTION are required")
    vector = embed_query(args, variant)
    matches: list[dict[str, Any]] = []
    payload_filter = build_qdrant_filter(args, scoped_ids)
    offset = 0
    for _ in range(max(1, args.max_pages)):
        request_body: dict[str, Any] = {
            "vector": vector,
            "limit": max(1, args.vector_limit),
            "offset": offset,
            "with_payload": True,
            "with_vector": False,
            "score_threshold": args.score_threshold,
        }
        if payload_filter:
            request_body["filter"] = payload_filter
        payload = post_json(
            f"{args.qdrant_url.rstrip('/')}/collections/{args.collection}/points/search",
            request_body,
            api_key=args.qdrant_api_key,
            bearer=False,
        )
        result = payload.get("result") or []
        if not result:
            break
        matches.extend(result)
        if len(result) < args.vector_limit:
            break
        offset += args.vector_limit
    return matches


def hydrate_hits(
    metadata_rows: dict[str, MetadataRow],
    chunk_hits: list[ChunkHit],
    chunk_target_chars: int,
) -> tuple[list[dict[str, Any]], dict[str, list[str]]]:
    grouped_hits: dict[str, dict[int, dict[str, Any]]] = defaultdict(dict)
    matched_ids = {hit.gutenberg_id for hit in chunk_hits}
    chunk_cache: dict[str, list[str]] = {}
    for gutenberg_id in matched_ids:
        metadata = metadata_rows.get(gutenberg_id)
        if not metadata or not metadata.clean_path:
            continue
        text = Path(metadata.clean_path).read_text(encoding="utf-8", errors="ignore")
        chunk_cache[gutenberg_id] = chunk_corpus_text(text, chunk_target_chars)

    hydrated: list[dict[str, Any]] = []
    for hit in chunk_hits:
        chunks = chunk_cache.get(hit.gutenberg_id)
        if not chunks or hit.chunk_index < 0 or hit.chunk_index >= len(chunks):
            continue
        existing = grouped_hits[hit.gutenberg_id].get(hit.chunk_index)
        if existing is None:
            hydrated_entry = {
                "gutenberg_id": hit.gutenberg_id,
                "source_id": hit.source_id,
                "chunk_index": hit.chunk_index,
                "text": chunks[hit.chunk_index],
                "score": hit.score,
                "variants": [hit.variant],
                "title": hit.title,
                "authors": hit.authors,
                "corpus_chunk_id": hit.corpus_chunk_id,
            }
            grouped_hits[hit.gutenberg_id][hit.chunk_index] = hydrated_entry
        else:
            existing["score"] = max(float(existing["score"]), hit.score)
            if hit.variant not in existing["variants"]:
                existing["variants"].append(hit.variant)
    for chunk_map in grouped_hits.values():
        hydrated.extend(sorted(chunk_map.values(), key=lambda item: item["chunk_index"]))
    return hydrated, chunk_cache


def build_review_packets(
    hydrated_hits: list[dict[str, Any]],
    metadata_rows: dict[str, MetadataRow],
    chunk_cache: dict[str, list[str]],
    args: argparse.Namespace,
) -> list[dict[str, Any]]:
    by_doc: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for hit in hydrated_hits:
        by_doc[hit["gutenberg_id"]].append(hit)

    packets: list[dict[str, Any]] = []
    for gutenberg_id, hits in by_doc.items():
        chunks = chunk_cache.get(gutenberg_id) or []
        if not chunks:
            continue
        metadata = metadata_rows.get(gutenberg_id)
        sorted_hits = sorted(hits, key=lambda item: int(item["chunk_index"]))
        groups: list[list[dict[str, Any]]] = []
        current_group: list[dict[str, Any]] = []
        for hit in sorted_hits:
            if not current_group:
                current_group = [hit]
                continue
            if int(hit["chunk_index"]) - int(current_group[-1]["chunk_index"]) <= args.merge_gap_chunks + 1:
                current_group.append(hit)
            else:
                groups.append(current_group)
                current_group = [hit]
        if current_group:
            groups.append(current_group)

        for group_index, group in enumerate(groups, start=1):
            left = min(int(item["chunk_index"]) for item in group)
            right = max(int(item["chunk_index"]) for item in group)
            total_chars = sum(len(chunks[index]) for index in range(left, right + 1))
            while total_chars < args.packet_min_chars and (left > 0 or right < len(chunks) - 1):
                left_candidate = left - 1 if left > 0 else None
                right_candidate = right + 1 if right < len(chunks) - 1 else None
                left_chars = len(chunks[left_candidate]) if left_candidate is not None else -1
                right_chars = len(chunks[right_candidate]) if right_candidate is not None else -1
                if right_candidate is not None and (right_chars >= left_chars):
                    if total_chars + right_chars > args.packet_max_chars and total_chars >= args.packet_min_chars:
                        break
                    right = right_candidate
                    total_chars += right_chars
                elif left_candidate is not None:
                    if total_chars + left_chars > args.packet_max_chars and total_chars >= args.packet_min_chars:
                        break
                    left = left_candidate
                    total_chars += left_chars
                else:
                    break

            packet_chunks = chunks[left:right + 1]
            packet_text = "\n\n".join(packet_chunks)
            normalized = re.sub(r"\s+", " ", packet_text).strip().lower()
            exact_hash = hashlib.sha1(packet_text.encode("utf-8")).hexdigest()
            near_hash = hashlib.sha1(normalized[:1200].encode("utf-8")).hexdigest()
            hit_variants = sorted({variant for item in group for variant in item["variants"]})
            packet = {
                "packet_id": f"{gutenberg_id}-{group_index:04d}",
                "gutenberg_id": gutenberg_id,
                "title": metadata.title if metadata else None,
                "author": metadata.author if metadata else None,
                "source_file": metadata.clean_path if metadata else None,
                "corpus_chunk_id": metadata.corpus_chunk_id if metadata else None,
                "start_chunk_index": left,
                "end_chunk_index": right,
                "matched_chunk_indexes": [int(item["chunk_index"]) for item in group],
                "source_ids": [f"gutenberg:{gutenberg_id}:{index}" for index in range(left, right + 1)],
                "variant_hits": hit_variants,
                "match_count": len(group),
                "max_score": max(float(item["score"]) for item in group),
                "packet_chars": len(packet_text),
                "packet_text": packet_text,
                "packet_excerpt": packet_text[:1200],
                "exact_text_hash": exact_hash,
                "near_text_hash": near_hash,
            }
            packets.append(packet)

    deduped: list[dict[str, Any]] = []
    seen_exact: set[str] = set()
    seen_near: set[tuple[str, str]] = set()
    for packet in sorted(packets, key=lambda item: (-float(item["max_score"]), item["gutenberg_id"], int(item["start_chunk_index"]))):
        exact_key = packet["exact_text_hash"]
        near_key = (packet["gutenberg_id"], packet["near_text_hash"])
        if exact_key in seen_exact or near_key in seen_near:
            continue
        seen_exact.add(exact_key)
        seen_near.add(near_key)
        deduped.append(packet)
    return deduped


def rerank_packets(args: argparse.Namespace, query: str, packets: list[dict[str, Any]], output_dir: Path) -> list[dict[str, Any]]:
    if args.disable_rerank or not packets:
        return packets
    if not args.openai_api_key:
        raise SystemExit("OPENAI_API_KEY is required for reranking")
    reranked: list[dict[str, Any]] = []
    batch_size = max(1, args.rerank_batch_size)
    for index in range(0, len(packets), batch_size):
        batch = packets[index:index + batch_size]
        schema = {
            "type": "json_schema",
            "json_schema": {
                "name": "packet_rerank",
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["packets"],
                    "properties": {
                        "packets": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["packet_id", "relevance_score", "reason"],
                                "properties": {
                                    "packet_id": {"type": "string"},
                                    "relevance_score": {"type": "number"},
                                    "reason": {"type": "string"},
                                },
                            },
                        },
                    },
                },
            },
        }
        prompt_packets = [
            {
                "packet_id": packet["packet_id"],
                "title": packet["title"],
                "author": packet["author"],
                "variant_hits": packet["variant_hits"],
                "max_score": packet["max_score"],
                "excerpt": packet["packet_excerpt"][:1200],
            }
            for packet in batch
        ]
        payload = post_json(
            f"{args.openai_base_url.rstrip('/')}/chat/completions",
            {
                "model": args.rerank_model,
                "response_format": schema,
                "messages": [
                    {
                        "role": "system",
                        "content": "You rerank bounded corpus retrieval packets for relevance to the original query. Return JSON only.",
                    },
                    {
                        "role": "user",
                        "content": json.dumps(
                            {
                                "query": query,
                                "task": "Score each packet for relevance to the original query. Use a 0-1 scale and keep packets that look plausibly useful, not just perfect matches.",
                                "packets": prompt_packets,
                            },
                            ensure_ascii=False,
                        ),
                    },
                ],
            },
            api_key=args.openai_api_key,
            bearer=True,
        )
        content = payload.get("choices", [{}])[0].get("message", {}).get("content", "")
        scored = json.loads(extract_json_object(str(content))).get("packets", [])
        score_map = {
            str(item.get("packet_id")): {
                "rerank_score": float(item.get("relevance_score", 0)),
                "rerank_reason": str(item.get("reason", "")).strip(),
            }
            for item in scored
        }
        for packet in batch:
            packet = dict(packet)
            packet.update(score_map.get(packet["packet_id"], {"rerank_score": 0.0, "rerank_reason": ""}))
            reranked.append(packet)
    reranked.sort(key=lambda item: (-float(item.get("rerank_score", 0)), -float(item.get("max_score", 0))))
    kept = reranked[:max(1, args.rerank_keep)]
    (output_dir / "reranked-packets.jsonl").write_text(
        "".join(json.dumps(packet, ensure_ascii=False) + "\n" for packet in kept),
        encoding="utf-8",
    )
    return kept


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def main() -> int:
    args = parse_args()
    if not args.precomputed_index_dir:
        raise SystemExit("--precomputed-index-dir or PRECOMPUTED_INDEX_DIR is required")

    output_dir = ensure_output_dir(args.output_dir)
    scoped_ids = set(str(value).strip() for value in args.gutenberg_id if str(value).strip())
    scoped_ids.update(parse_ids_file(args.gutenberg_ids_file))
    scoped_ids.update(parse_scope_file(args.scope_file))
    scoped_ids.update(parse_chunk_map_ids(
        args.chunk_map_path or str(Path(args.precomputed_index_dir) / "corpus-vector-chunk-map.json"),
        args.corpus_chunk_id,
    ))

    metadata_rows = load_metadata_index(args.precomputed_index_dir, scoped_ids)
    if scoped_ids:
        metadata_rows = {key: value for key, value in metadata_rows.items() if key in scoped_ids}
    scoped_ids = set(metadata_rows.keys())
    if not scoped_ids:
        raise SystemExit("The bounded scope resolved to zero Gutenberg ids")

    variants = expand_query_variants(args, output_dir)

    dense_rows: list[dict[str, Any]] = []
    chunk_hits: list[ChunkHit] = []
    for variant in variants:
        matches = search_qdrant_variant(args, variant, scoped_ids)
        for match in matches:
            payload = match.get("payload") or {}
            gutenberg_id = str(payload.get("gutenberg_id") or "").strip()
            if not gutenberg_id or gutenberg_id not in scoped_ids:
                continue
            chunk_index = int(payload.get("chunk_index", 0))
            source_id = f"gutenberg:{gutenberg_id}:{chunk_index}"
            authors = parse_authors(payload.get("authors"))
            chunk_hit = ChunkHit(
                gutenberg_id=gutenberg_id,
                source_id=source_id,
                chunk_index=chunk_index,
                score=float(match.get("score", 0)),
                variant=variant,
                title=str(payload.get("title")).strip() if payload.get("title") else None,
                authors=authors,
                corpus_chunk_id=str(payload.get("corpus_chunk_id")).strip() if payload.get("corpus_chunk_id") else None,
            )
            chunk_hits.append(chunk_hit)
            dense_rows.append(
                {
                    "variant": variant,
                    "gutenberg_id": gutenberg_id,
                    "source_id": source_id,
                    "chunk_index": chunk_index,
                    "score": chunk_hit.score,
                    "title": chunk_hit.title,
                    "authors": chunk_hit.authors,
                    "corpus_chunk_id": chunk_hit.corpus_chunk_id,
                    "qdrant_point_id": match.get("id"),
                },
            )

    write_jsonl(output_dir / "dense-matches.jsonl", dense_rows)

    hydrated_hits, chunk_cache = hydrate_hits(metadata_rows, chunk_hits, args.chunk_target_chars)
    write_jsonl(output_dir / "hydrated-hits.jsonl", hydrated_hits)

    packets = build_review_packets(hydrated_hits, metadata_rows, chunk_cache, args)
    write_jsonl(output_dir / "review-packets.jsonl", packets)
    reranked_packets = rerank_packets(args, args.query, packets, output_dir)

    grouped_by_doc: dict[str, int] = defaultdict(int)
    for packet in reranked_packets:
        grouped_by_doc[packet["gutenberg_id"]] += 1

    summary = {
        "query": args.query,
        "scope_gutenberg_id_count": len(scoped_ids),
        "variant_count": len(variants),
        "dense_match_count": len(dense_rows),
        "hydrated_hit_count": len(hydrated_hits),
        "review_packet_count": len(packets),
        "kept_packet_count": len(reranked_packets),
        "documents_with_packets": len(grouped_by_doc),
        "rerank_enabled": not args.disable_rerank,
        "output_files": {
            "query_expansion": str(output_dir / "query-expansion.json"),
            "dense_matches": str(output_dir / "dense-matches.jsonl"),
            "hydrated_hits": str(output_dir / "hydrated-hits.jsonl"),
            "review_packets": str(output_dir / "review-packets.jsonl"),
            "reranked_packets": str(output_dir / "reranked-packets.jsonl"),
        },
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
