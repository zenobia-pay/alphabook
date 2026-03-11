from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class Settings:
    root_dir: Path
    data_dir: Path
    raw_dir: Path
    cache_dir: Path
    db_path: Path
    embed_model: str
    fallback_embed_dimensions: int
    terminaluse_project_id: Optional[str]
    terminaluse_agent_name: Optional[str]
    terminaluse_branch: Optional[str]


def load_settings(root_dir: Optional[Path] = None) -> Settings:
    resolved_root = Path(root_dir or Path.cwd()).resolve()
    data_dir = Path(os.environ.get("ALPHABOOK_DATA_DIR", resolved_root / "data")).resolve()
    raw_dir = data_dir / "raw"
    cache_dir = data_dir / "cache"
    db_path = Path(os.environ.get("ALPHABOOK_DB_PATH", data_dir / "corpus.sqlite3")).resolve()

    raw_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    return Settings(
        root_dir=resolved_root,
        data_dir=data_dir,
        raw_dir=raw_dir,
        cache_dir=cache_dir,
        db_path=db_path,
        embed_model=os.environ.get("ALPHABOOK_EMBED_MODEL", "text-embedding-3-small"),
        fallback_embed_dimensions=int(os.environ.get("ALPHABOOK_FALLBACK_EMBED_DIMS", "256")),
        terminaluse_project_id=os.environ.get("ALPHABOOK_TERMINALUSE_PROJECT_ID"),
        terminaluse_agent_name=os.environ.get("ALPHABOOK_TERMINALUSE_AGENT_NAME"),
        terminaluse_branch=os.environ.get("ALPHABOOK_TERMINALUSE_BRANCH"),
    )
