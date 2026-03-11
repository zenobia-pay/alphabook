from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.request import urlopen


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from alphabook.catalogue import get_seed  # noqa: E402
from alphabook.chunking import chunk_text  # noqa: E402
from alphabook.text import strip_project_gutenberg_boilerplate  # noqa: E402


def download_text(url: str) -> str:
    with urlopen(url, timeout=30) as response:
        return response.read().decode("utf-8", errors="ignore")


def main() -> None:
    seed = get_seed("don-quixote")
    raw_text = download_text(seed.source_url)
    text = strip_project_gutenberg_boilerplate(raw_text)
    chunk_drafts = chunk_text(text)

    payload = {
        "book": {
            "id": seed.id,
            "title": seed.title,
            "author": seed.author,
            "sourceUrl": seed.source_url,
            "textLength": len(text),
            "chunkCount": len(chunk_drafts),
        },
        "chunks": [
            {
                "id": f"{seed.id}:{chunk.chunk_index:05d}",
                "bookId": seed.id,
                "chunkIndex": chunk.chunk_index,
                "startChar": chunk.start_char,
                "endChar": chunk.end_char,
                "content": chunk.content,
            }
            for chunk in chunk_drafts
        ],
    }

    output_path = REPO_ROOT / "src" / "generated" / "don-quixote.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=True), encoding="utf-8")
    print(f"Wrote {output_path} with {len(chunk_drafts)} chunks.")


if __name__ == "__main__":
    main()
