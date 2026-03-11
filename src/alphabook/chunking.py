from __future__ import annotations

import re
from typing import List, Sequence, Tuple

from .models import ChunkDraft
from .text import normalize_newlines


SENTENCE_BREAK_RE = re.compile(r"(?<=[.!?])\s+")


def _split_long_paragraph(paragraph: str, target_chars: int) -> List[str]:
    if len(paragraph) <= target_chars:
        return [paragraph]

    sentences = [sentence.strip() for sentence in SENTENCE_BREAK_RE.split(paragraph) if sentence.strip()]
    if len(sentences) <= 1:
        return [paragraph[index : index + target_chars] for index in range(0, len(paragraph), target_chars)]

    pieces: List[str] = []
    current = ""
    for sentence in sentences:
        candidate = sentence if not current else f"{current} {sentence}"
        if current and len(candidate) > target_chars:
            pieces.append(current)
            current = sentence
        else:
            current = candidate
    if current:
        pieces.append(current)
    return pieces


def _prepare_paragraphs(text: str, target_chars: int) -> Sequence[Tuple[str, int, int]]:
    normalized = normalize_newlines(text)
    raw_paragraphs = [paragraph.strip() for paragraph in re.split(r"\n\s*\n", normalized) if paragraph.strip()]
    expanded: List[str] = []
    for paragraph in raw_paragraphs:
        expanded.extend(_split_long_paragraph(paragraph, target_chars))

    spans: List[Tuple[str, int, int]] = []
    cursor = 0
    for paragraph in expanded:
        start = cursor
        end = start + len(paragraph)
        spans.append((paragraph, start, end))
        cursor = end + 2
    return spans


def _joined_length(paragraphs: Sequence[Tuple[str, int, int]]) -> int:
    if not paragraphs:
        return 0
    return sum(len(paragraph[0]) for paragraph in paragraphs) + (2 * (len(paragraphs) - 1))


def _select_overlap(paragraphs: Sequence[Tuple[str, int, int]], overlap_chars: int) -> List[Tuple[str, int, int]]:
    overlap: List[Tuple[str, int, int]] = []
    current = 0
    for paragraph in reversed(paragraphs):
        overlap.insert(0, paragraph)
        current = _joined_length(overlap)
        if current >= overlap_chars:
            break
    return overlap


def chunk_text(text: str, target_chars: int = 1800, overlap_chars: int = 250) -> List[ChunkDraft]:
    split_target = max(1, target_chars - overlap_chars)
    paragraphs = list(_prepare_paragraphs(text, split_target))
    if not paragraphs:
        return []

    chunks: List[ChunkDraft] = []
    active: List[Tuple[str, int, int]] = []
    index = 0
    paragraph_cursor = 0

    while paragraph_cursor < len(paragraphs):
        paragraph = paragraphs[paragraph_cursor]
        pending = _joined_length(active + [paragraph])

        if active and pending > target_chars:
            flushed_content = "\n\n".join(item[0] for item in active)
            flushed_start = active[0][1]
            flushed_end = active[-1][2]
            chunks.append(
                ChunkDraft(
                    chunk_index=index,
                    start_char=flushed_start,
                    end_char=flushed_end,
                    content=flushed_content,
                )
            )
            index += 1
            active = _select_overlap(active, overlap_chars)
            while active and _joined_length(active + [paragraph]) > target_chars:
                active = active[1:]
            if not active and overlap_chars > 0:
                overlap_budget = max(0, target_chars - len(paragraph[0]) - 2)
                overlap_size = min(overlap_chars, overlap_budget)
                if overlap_size > 0:
                    tail_text = flushed_content[-overlap_size:]
                    tail_start = max(flushed_start, flushed_end - len(tail_text))
                    active = [(tail_text, tail_start, flushed_end)]
            continue

        active.append(paragraph)
        paragraph_cursor += 1

    if active:
        chunks.append(
            ChunkDraft(
                chunk_index=index,
                start_char=active[0][1],
                end_char=active[-1][2],
                content="\n\n".join(item[0] for item in active),
            )
        )

    return chunks
