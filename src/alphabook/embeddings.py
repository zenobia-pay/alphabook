from __future__ import annotations

import hashlib
import math
import os
from typing import List, Optional, Sequence

from .config import Settings
from .text import tokenize

try:
    from openai import OpenAI
except ImportError:  # pragma: no cover
    OpenAI = None  # type: ignore[assignment]


def l2_normalize(vector: Sequence[float]) -> List[float]:
    magnitude = math.sqrt(sum(value * value for value in vector))
    if magnitude == 0:
        return [0.0 for _ in vector]
    return [value / magnitude for value in vector]


def cosine_similarity(left: Sequence[float], right: Sequence[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    return sum(lhs * rhs for lhs, rhs in zip(left, right))


def average_vectors(vectors: Sequence[Sequence[float]]) -> List[float]:
    if not vectors:
        return []
    width = len(vectors[0])
    totals = [0.0] * width
    for vector in vectors:
        for index, value in enumerate(vector):
            totals[index] += value
    return l2_normalize([value / len(vectors) for value in totals])


class BaseEmbeddingProvider:
    model_name: str

    def embed_texts(self, texts: Sequence[str]) -> List[List[float]]:
        raise NotImplementedError


class HashedEmbeddingProvider(BaseEmbeddingProvider):
    def __init__(self, dimensions: int = 256):
        self.dimensions = dimensions
        self.model_name = f"hashed-bow-{dimensions}"

    def embed_texts(self, texts: Sequence[str]) -> List[List[float]]:
        vectors: List[List[float]] = []
        for text in texts:
            vector = [0.0] * self.dimensions
            for token in tokenize(text):
                digest = hashlib.sha256(token.encode("utf-8")).digest()
                bucket = int.from_bytes(digest[:4], "big") % self.dimensions
                sign = -1.0 if digest[4] % 2 else 1.0
                vector[bucket] += sign
            vectors.append(l2_normalize(vector))
        return vectors


class OpenAIEmbeddingProvider(BaseEmbeddingProvider):
    def __init__(self, api_key: str, model_name: str):
        if OpenAI is None:  # pragma: no cover
            raise RuntimeError("openai package is not installed")
        self.client = OpenAI(api_key=api_key)
        self.model_name = model_name

    def embed_texts(self, texts: Sequence[str]) -> List[List[float]]:
        if not texts:
            return []

        vectors: List[List[float]] = []
        batch_size = 64
        for start in range(0, len(texts), batch_size):
            batch = list(texts[start : start + batch_size])
            response = self.client.embeddings.create(model=self.model_name, input=batch)
            vectors.extend([l2_normalize(item.embedding) for item in response.data])
        return vectors


def build_embedding_provider(settings: Settings) -> BaseEmbeddingProvider:
    api_key = os.environ.get("OPENAI_API_KEY")
    if api_key:
        try:
            return OpenAIEmbeddingProvider(api_key=api_key, model_name=settings.embed_model)
        except Exception:
            pass
    return HashedEmbeddingProvider(dimensions=settings.fallback_embed_dimensions)
