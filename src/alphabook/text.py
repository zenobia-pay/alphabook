from __future__ import annotations

import re
from typing import Iterable, List


WORD_RE = re.compile(r"[A-Za-z0-9']+")


def normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def strip_project_gutenberg_boilerplate(text: str) -> str:
    normalized = normalize_newlines(text).lstrip("\ufeff")
    start_match = re.search(
        r"\*\*\* START OF THE PROJECT GUTENBERG EBOOK.*?\*\*\*",
        normalized,
        flags=re.IGNORECASE,
    )
    end_match = re.search(
        r"\*\*\* END OF THE PROJECT GUTENBERG EBOOK.*?\*\*\*",
        normalized,
        flags=re.IGNORECASE,
    )
    if start_match:
        normalized = normalized[start_match.end() :]
    end_match = re.search(
        r"\*\*\* END OF THE PROJECT GUTENBERG EBOOK.*?\*\*\*",
        normalized,
        flags=re.IGNORECASE,
    )
    if end_match:
        normalized = normalized[: end_match.start()]
    return normalized.strip()


def tokenize(text: str) -> List[str]:
    return [match.group(0).lower() for match in WORD_RE.finditer(text)]


def slugify(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return cleaned or "untitled"


def make_excerpt(text: str, query: str, window: int = 220) -> str:
    collapsed = " ".join(text.split())
    if not collapsed:
        return ""

    lower = collapsed.lower()
    positions = [lower.find(token) for token in tokenize(query)]
    positions = [position for position in positions if position >= 0]
    center = positions[0] if positions else min(len(collapsed) // 2, max(0, len(collapsed) - 1))
    start = max(0, center - (window // 3))
    end = min(len(collapsed), start + window)
    excerpt = collapsed[start:end]
    if start > 0:
        excerpt = "..." + excerpt
    if end < len(collapsed):
        excerpt = excerpt + "..."
    return excerpt


def unique_preserving_order(values: Iterable[str]) -> List[str]:
    seen = set()
    ordered: List[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered
