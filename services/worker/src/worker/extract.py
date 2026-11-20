"""Raw file -> text. HTML is extracted locally with trafilatura; PDFs and images
go to Gemini OCR (see ai.py). PDFs are split into parts of N pages first, so
one call never has to transcribe more than N pages."""

from __future__ import annotations

import io
from dataclasses import dataclass, field

import trafilatura
from pypdf import PdfReader, PdfWriter
from pypdf.errors import PdfReadError

from .errors import PermanentError

HTML_TYPES = {"text/html", "application/xhtml+xml"}
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/tiff"}
PDF = "application/pdf"


@dataclass
class Extracted:
    text: str
    hints: dict[str, str] = field(default_factory=dict)  # title, author, date from page metadata
    pages: int | None = None
    method: str = "html"


def decode_html(raw: bytes) -> str:
    for enc in ("utf-8", "utf-16"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def extract_html(raw: bytes, url: str | None) -> Extracted:
    html = decode_html(raw)
    text = trafilatura.extract(html, url=url, include_comments=False, include_tables=True, favor_recall=True) or ""
    hints: dict[str, str] = {}
    meta = trafilatura.extract_metadata(html, default_url=url)
    if meta is not None:
        for key in ("title", "author", "date", "sitename"):
            value = getattr(meta, key, None)
            if value:
                hints[key] = str(value)
    return Extracted(text=text.strip(), hints=hints, method="html")


def split_pdf(raw: bytes, pages_per_part: int, max_pages: int) -> tuple[list[bytes], int]:
    """Returns PDF parts of at most `pages_per_part` pages, and the total page count."""
    try:
        reader = PdfReader(io.BytesIO(raw))
        if reader.is_encrypted:
            raise PermanentError("pdf_encrypted", "the PDF is password-protected")
        total = len(reader.pages)
    except PdfReadError as e:
        raise PermanentError("pdf_unreadable", f"the PDF can't be read: {e}") from e
    if total == 0:
        raise PermanentError("pdf_empty", "the PDF has no pages")
    if total > max_pages:
        raise PermanentError("pdf_too_long", f"the PDF has {total} pages; the limit is {max_pages}")
    if total <= pages_per_part:
        return [raw], total
    parts = []
    for start in range(0, total, pages_per_part):
        w = PdfWriter()
        for i in range(start, min(start + pages_per_part, total)):
            w.add_page(reader.pages[i])
        buf = io.BytesIO()
        w.write(buf)
        parts.append(buf.getvalue())
    return parts, total
