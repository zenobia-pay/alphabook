FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.6.4 /uv /uvx /bin/

RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap \
    curl \
    git \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

ENV UV_LINK_MODE=copy \
    PATH="/root/.local/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

WORKDIR /app/book_research_agent

COPY book_research_agent/pyproject.toml /app/book_research_agent/pyproject.toml
COPY book_research_agent/src /app/book_research_agent/src
COPY book_research_agent/config.yaml /app/book_research_agent/config.yaml

RUN uv pip install --system /app/book_research_agent \
    && npm install -g @openai/codex

ENTRYPOINT ["uvicorn", "src.agent:server", "--host", "0.0.0.0"]
