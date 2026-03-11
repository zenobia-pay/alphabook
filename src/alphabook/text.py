from __future__ import annotations

import re
from html import unescape
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


def strip_html_tags(html: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", html)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|section|article|h1|h2|h3|h4|h5|h6|li|tr|blockquote)>", "\n", text)
    text = re.sub(r"(?i)<hr[^>]*>", "\n", text)
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    text = unescape(text)
    text = normalize_newlines(text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


def parse_gutenberg_text(source_url: str, raw_text: str) -> dict:
    normalized = normalize_newlines(raw_text).lstrip("\ufeff")
    machine_title = re.search(r"(?im)^\s*Title:\s*(.+)$", normalized)
    machine_author = re.search(r"(?im)^\s*Author:\s*(.+)$", normalized)
    title = machine_title.group(1).strip() if machine_title else ""
    author = machine_author.group(1).strip() if machine_author else "Unknown"
    text = strip_project_gutenberg_boilerplate(normalized)
    if not title:
        title = slugify(source_url)

    epub_match = re.search(r"/(?:epub|ebooks|files)/(\d+)", source_url)
    book_id = f"gutenberg-{epub_match.group(1)}" if epub_match else slugify(title)

    return {
        "book_id": book_id,
        "title": title.strip(),
        "author": author.strip(),
        "text": text.strip(),
    }


def parse_gutenberg_html(source_url: str, html: str) -> dict:
    normalized = normalize_newlines(html).lstrip("\ufeff")
    title_match = re.search(r"(?is)<title>(.*?)</title>", normalized)
    title_text = strip_html_tags(title_match.group(1)) if title_match else ""

    body_match = re.search(r"(?is)<body[^>]*>(.*)</body>", normalized)
    body_html = body_match.group(1) if body_match else normalized
    body_html = re.sub(r'(?is)<div[^>]+id="pg-header"[^>]*>.*?</div>', " ", body_html)
    body_html = re.sub(r'(?is)<div[^>]+id="pg-footer"[^>]*>.*?</div>', " ", body_html)
    text = strip_html_tags(body_html)

    header_title = ""
    author = ""
    machine_title = re.search(r"(?im)^\s*Title:\s*(.+)$", text)
    machine_author = re.search(r"(?im)^\s*Author:\s*(.+)$", text)
    if machine_title:
        header_title = machine_title.group(1).strip()
    if machine_author:
        author = machine_author.group(1).strip()

    if not header_title:
        title_from_title = re.sub(r"^The Project Gutenberg eBook of\s*", "", title_text, flags=re.I).strip(" .")
        title_author_match = re.match(r"(.+?),\s+by\s+(.+)$", title_from_title, flags=re.I)
        if title_author_match:
            header_title = title_author_match.group(1).strip()
            if not author:
                author = title_author_match.group(2).strip().rstrip(".")
        else:
            header_title = title_from_title

    if not header_title:
        h1_match = re.search(r"(?is)<h1[^>]*>(.*?)</h1>", normalized)
        header_title = strip_html_tags(h1_match.group(1)) if h1_match else slugify(source_url)

    if not author:
        author = "Unknown"

    epub_match = re.search(r"/epub/(\d+)/", source_url)
    book_id = f"gutenberg-{epub_match.group(1)}" if epub_match else slugify(header_title)

    return {
        "book_id": book_id,
        "title": header_title.strip(),
        "author": author.strip(),
        "text": text.strip(),
    }


def parse_gutenberg_source(source_url: str, raw_source: str) -> dict:
    if re.search(r"(?is)<!doctype html|<html|<body[^>]*>", raw_source):
        return parse_gutenberg_html(source_url, raw_source)
    return parse_gutenberg_text(source_url, raw_source)
