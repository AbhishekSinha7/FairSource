"""Run the full worker pipeline on one page or file with real Gemini calls,
without Google Cloud (Firestore, Storage and Pub/Sub are in memory).

    set GEMINI_API_KEY=...            (Command Prompt; get a key in Google AI Studio)
    .venv\\Scripts\\python scripts\\try_gemini.py https://example.in/some/article
    .venv\\Scripts\\python scripts\\try_gemini.py path\\to\\scan.pdf

Prints the structured document, the safety and language results, and the chunks.
"""

from __future__ import annotations

import mimetypes
import sys
import urllib.request
from pathlib import Path

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / "src"), str(Path(__file__).resolve().parents[1])]

from tests.fakes import Harness  # noqa: E402
from worker.ai import GeminiAI  # noqa: E402
from worker.config import load_settings  # noqa: E402
from worker.models import ContentRawMessage  # noqa: E402
from worker.pipeline import process  # noqa: E402


def main(target: str) -> None:
    if target.startswith(("http://", "https://")):
        req = urllib.request.Request(target, headers={"User-Agent": "FairSourceBot/0.1 (local test)"})
        with urllib.request.urlopen(req, timeout=20) as r:
            data, mime, url = r.read(), r.headers.get_content_type(), target
    else:
        p = Path(target)
        data, mime, url = p.read_bytes(), mimetypes.guess_type(p.name)[0] or "application/octet-stream", None

    h = Harness()
    s = load_settings()
    h.deps.settings = s.__class__(**{**s.__dict__, "clean_bucket": "local-clean"})
    h.deps.ai = GeminiAI(h.deps.settings)
    h.deps.log = lambda **kw: print("log:", kw)
    h.stub("local", url or "", sourceUrl=url, title=Path(target).stem)
    msg = h.message("local", data, mime=mime, url=url)

    out = process(ContentRawMessage.model_validate(msg), h.deps)
    d = h.store.documents["local"]
    print(f"\noutcome: {out.status} {out.reason}")
    for k in ("title", "author", "publishedAt", "language", "script", "contentType", "qualityScore", "topics", "summary", "safety", "needsReview", "duplicateOf", "servable", "chunkCount", "tokenCount", "processingError"):
        print(f"{k:>15}: {d.get(k)}")
    for c in h.store.chunks_of("local"):
        print(f"\n--- chunk {c['n']} · {c['tokenCount']} tokens\n{c['text'][:400]}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
