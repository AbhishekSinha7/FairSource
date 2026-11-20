"""Worker settings. Model IDs come from prompts/models.json, overridable by env."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

REPO_PROMPTS = Path(__file__).resolve().parents[4] / "prompts"  # repo checkout
IMAGE_PROMPTS = Path("/app/prompts")  # container (see Dockerfile)


def prompts_dir() -> Path:
    env = os.environ.get("PROMPTS_DIR")
    if env:
        return Path(env)
    return IMAGE_PROMPTS if IMAGE_PROMPTS.exists() else REPO_PROMPTS


@dataclass(frozen=True)
class Settings:
    project: str
    raw_bucket: str
    clean_bucket: str
    model_pro: str
    model_flash: str
    model_embedding: str
    model_gemma: str
    embedding_dims: int = 768
    embed_batch: int = 100
    chunk_min_tokens: int = 400
    chunk_max_tokens: int = 600
    chunk_overlap_tokens: int = 60
    ocr_pages_per_call: int = 10
    max_pdf_pages: int = 300
    max_input_chars: int = 200_000
    exact_token_counts: bool = True
    dedup_max_hamming: int = 8


def load_settings(env: dict[str, str] | None = None) -> Settings:
    e = dict(os.environ if env is None else env)
    try:
        models = json.loads((prompts_dir() / "models.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        models = {}

    def model(key: str, env_key: str, default: str) -> str:
        return e.get(env_key) or models.get(key) or default

    project = e.get("GOOGLE_CLOUD_PROJECT", "fs-dev")
    return Settings(
        project=project,
        raw_bucket=e.get("RAW_BUCKET", f"{project}-raw"),
        clean_bucket=e.get("CLEAN_BUCKET", f"{project}-clean"),
        model_pro=model("pro", "MODEL_PRO", "gemini-2.5-pro"),
        model_flash=model("flash", "MODEL_FLASH", "gemini-2.5-flash"),
        model_embedding=model("embedding", "MODEL_EMBEDDING", "gemini-embedding-001"),
        model_gemma=model("gemma", "MODEL_GEMMA", "gemma-3-27b-it"),
        embedding_dims=int(models.get("embeddingDimensions", 768)),
        embed_batch=int(e.get("EMBED_BATCH", "100")),
        exact_token_counts=e.get("EXACT_TOKEN_COUNTS", "1") != "0",
    )
