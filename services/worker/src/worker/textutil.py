"""Text helpers with no network calls: token estimate, script and language
check, SimHash, and the chunker."""

from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from dataclasses import dataclass

# --------------------------------------------------------------- tokens

_DEVANAGARI = re.compile(r"[ऀ-ॿ꣠-ꣿ]")
_LATIN = re.compile(r"[A-Za-z]")


def estimate_tokens(text: str) -> int:
    """Rough Gemini token count, used to size chunks. Stored token counts (which
    drive billing) come from the API's count_tokens when available.
    About 4 characters per token for ASCII text, about 2.5 for other scripts."""
    if not text:
        return 0
    ascii_chars = sum(1 for c in text if ord(c) < 128 and not c.isspace())
    other = sum(1 for c in text if ord(c) >= 128 and not c.isspace())
    return max(1, math.ceil(ascii_chars / 4 + other / 2.5))


# --------------------------------------------------------- script / lang


def detect_script(text: str) -> str | None:
    """ISO 15924 code of the dominant script, for the scripts FairSource handles."""
    deva = len(_DEVANAGARI.findall(text))
    latin = len(_LATIN.findall(text))
    if deva == 0 and latin == 0:
        return None
    return "Deva" if deva >= latin else "Latn"


_WORD = re.compile(r"[\wऀ-ॿ]+", re.UNICODE)

# Frequent function words that separate Marathi from Hindi (both Devanagari).
_MR = {"आहे", "आहेत", "आणि", "च्या", "मध्ये", "केले", "होते", "नाही", "त्या", "हे", "या", "असे", "आली", "आला", "करण्यात", "सांगितले"}
_HI = {"है", "हैं", "और", "के", "में", "की", "का", "नहीं", "से", "किया", "गया", "यह", "थे", "था", "लिए", "कहा"}
_EN = {"the", "and", "of", "to", "in", "is", "that", "for", "was", "with", "on", "as"}


def guess_language(text: str) -> str | None:
    """Local check of Gemini's language: 'mr', 'hi', 'en' when the evidence is
    clear, otherwise None (no opinion). Marathi also uses ळ much more than Hindi."""
    words = [unicodedata.normalize("NFC", w).lower() for w in _WORD.findall(text[:20_000])]
    if not words:
        return None
    script = detect_script(text)
    if script == "Deva":
        mr = sum(1 for w in words if w in _MR) + text.count("ळ")
        hi = sum(1 for w in words if w in _HI)
        if max(mr, hi) < 3:
            return None
        if mr >= 2 * hi:
            return "mr"
        if hi >= 2 * mr:
            return "hi"
        return None
    if script == "Latn":
        en = sum(1 for w in words if w in _EN)
        return "en" if en >= 3 and en / len(words) > 0.04 else None
    return None


SCRIPT_OF_LANGUAGE = {"mr": "Deva", "hi": "Deva", "ne": "Deva", "sa": "Deva", "kok": "Deva", "en": "Latn"}


def language_agrees(text: str, language: str, script: str) -> bool:
    """True when the local check finds no contradiction with Gemini's language/script."""
    detected = detect_script(text)
    if detected and script and detected != script:
        return False
    expected = SCRIPT_OF_LANGUAGE.get(language)
    if expected and detected and expected != detected:
        return False
    guess = guess_language(text)
    return guess is None or guess == language


# --------------------------------------------------------------- simhash


def simhash64(text: str) -> int:
    """64-bit SimHash over word 3-shingles. Near-identical texts differ in few bits."""
    words = [w.lower() for w in _WORD.findall(unicodedata.normalize("NFC", text))]
    shingles = [" ".join(words[i : i + 3]) for i in range(max(1, len(words) - 2))] if words else [""]
    acc = [0] * 64
    for s in shingles:
        h = int.from_bytes(hashlib.blake2b(s.encode("utf-8"), digest_size=8).digest(), "big")
        for bit in range(64):
            acc[bit] += 1 if (h >> bit) & 1 else -1
    return sum(1 << bit for bit in range(64) if acc[bit] > 0)


def bands(h: int) -> tuple[int, int, int, int]:
    """Four 16-bit bands. Texts within 3 bits always share at least one band."""
    return tuple((h >> (16 * i)) & 0xFFFF for i in range(4))  # type: ignore[return-value]


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()


# --------------------------------------------------------------- chunker

_SENTENCE_END = re.compile(r"(?<=[.!?।॥])\s+")


@dataclass(frozen=True)
class ChunkPlan:
    text: str  # title on the first line, then body text
    estimated_tokens: int


def _split_long(unit: str, max_tokens: int) -> list[str]:
    """Split an over-long paragraph by sentences, then by words."""
    out: list[str] = []
    for sentence in _SENTENCE_END.split(unit):
        if estimate_tokens(sentence) <= max_tokens:
            out.append(sentence)
            continue
        words = sentence.split()
        piece: list[str] = []
        for w in words:
            if piece and estimate_tokens(" ".join(piece + [w])) > max_tokens:
                out.append(" ".join(piece))
                piece = []
            piece.append(w)
        if piece:
            out.append(" ".join(piece))
    return [o for o in out if o.strip()]


def _tail(text: str, tokens: int) -> str:
    """The last ~`tokens` tokens of text, on a word boundary."""
    words = text.split()
    tail: list[str] = []
    for w in reversed(words):
        tail.insert(0, w)
        if estimate_tokens(" ".join(tail)) >= tokens:
            break
    return " ".join(tail)


def plan_chunks(title: str, body: str, min_tokens: int = 400, max_tokens: int = 600, overlap: int = 60) -> list[ChunkPlan]:
    """Paragraph-aware chunks of min..max tokens (title included), each starting
    with the title and overlapping the previous chunk by about `overlap` tokens."""
    title = " ".join(title.split())
    budget = max(100, max_tokens - estimate_tokens(title) - 2)
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
    units: list[str] = []
    for p in paragraphs:
        units.extend([p] if estimate_tokens(p) <= budget else _split_long(p, budget))
    if not units:
        return []

    groups: list[list[str]] = []
    current: list[str] = []
    starts_with_overlap = False
    for u in units:
        if current and estimate_tokens("\n\n".join(current + [u])) > budget:
            groups.append(current)
            tail = _tail("\n\n".join(current), overlap)
            starts_with_overlap = bool(tail) and estimate_tokens(tail + " " + u) <= budget
            current = [tail] if starts_with_overlap else []
        current.append(u)
    if current:
        # Fold a small remainder into the previous chunk when it fits (without
        # repeating the overlap, which that chunk already contains).
        own = current[1:] if starts_with_overlap else current
        if groups and estimate_tokens("\n\n".join(current)) < min_tokens / 2 and estimate_tokens("\n\n".join(groups[-1] + own)) <= budget * 1.15:
            groups[-1].extend(own)
        else:
            groups.append(current)

    out = []
    for g in groups:
        text = f"{title}\n" + "\n\n".join(g)
        out.append(ChunkPlan(text=text, estimated_tokens=estimate_tokens(text)))
    return out


def sha256_text(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


_PHONE = re.compile(r"(?<!\d)(?:\+91[\s-]?)?[6-9]\d{9}(?!\d)")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")


def personal_data_count(text: str) -> int:
    """Phone numbers and email addresses: a cheap signal for lists of people."""
    return len(_PHONE.findall(text)) + len(_EMAIL.findall(text))
