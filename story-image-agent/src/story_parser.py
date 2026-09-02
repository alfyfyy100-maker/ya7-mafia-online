"""Story parsing: turn a plain text story into an ordered list of Parts.

The parser recognises headings such as `Part 1:`, `Scene 2`, `Chapter III`,
`الجزء ١:`, `المشهد الثاني` — the keyword list lives in config so more forms can
be added without code changes. If a story has no headings at all it falls back
to grouping paragraphs, so the pipeline still works on unstructured text.

The original story text is never rewritten; a Part's body is an exact slice of
the source file.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

from logger import get_logger

log = get_logger("parser")

_ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")

_ARABIC_ORDINALS = {
    "الأول": 1, "الاول": 1, "الأولى": 1, "الاولى": 1, "أول": 1, "اول": 1,
    "الثاني": 2, "الثانية": 2, "ثاني": 2,
    "الثالث": 3, "الثالثة": 3, "ثالث": 3,
    "الرابع": 4, "الرابعة": 4,
    "الخامس": 5, "الخامسة": 5,
    "السادس": 6, "السادسة": 6,
    "السابع": 7, "السابعة": 7,
    "الثامن": 8, "الثامنة": 8,
    "التاسع": 9, "التاسعة": 9,
    "العاشر": 10, "العاشرة": 10,
}

_ROMAN = {"i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7,
          "viii": 8, "ix": 9, "x": 10, "xi": 11, "xii": 12}

_MAX_HEADING_CHARS = 120


@dataclass
class Part:
    """One story unit that will become exactly one generated image."""

    index: int
    text: str
    heading: str = ""
    title: str = ""
    label: str = ""
    source_number: int | None = None

    @property
    def slug(self) -> str:
        return f"part_{self.index:03d}"

    @property
    def word_count(self) -> int:
        return len(self.text.split())

    def to_dict(self) -> dict[str, object]:
        return {
            "index": self.index,
            "label": self.label,
            "heading": self.heading,
            "title": self.title,
            "source_number": self.source_number,
            "word_count": self.word_count,
            "text": self.text,
        }


@dataclass
class Story:
    """The parsed story: ordered parts plus how they were detected."""

    parts: list[Part] = field(default_factory=list)
    source_path: Path | None = None
    detection: str = "none"

    def __len__(self) -> int:
        return len(self.parts)

    def __iter__(self) -> Iterable[Part]:
        return iter(self.parts)

    def get(self, index: int) -> Part | None:
        for part in self.parts:
            if part.index == index:
                return part
        return None

    def slice(self, start: int | None = None, limit: int | None = None) -> list[Part]:
        selected = [p for p in self.parts if start is None or p.index >= start]
        return selected[:limit] if limit else selected


class StoryParseError(RuntimeError):
    """Raised when the story file is missing or empty."""


_DIACRITICS_RE = re.compile(r"[\u064B-\u0652\u0670\u06D6-\u06ED\u0640]")


def _normalise(text: str) -> str:
    """Strips Arabic vowel marks/tatweel and maps Arabic-Indic digits to ASCII.

    Letters are left intact (no NFKD), so hamza carriers such as ئ survive.
    """
    text = text.translate(_ARABIC_DIGITS)
    return _DIACRITICS_RE.sub("", unicodedata.normalize("NFC", text))


def _build_heading_pattern(keywords: Sequence[str]) -> re.Pattern[str]:
    escaped = sorted((re.escape(_normalise(k.strip())) for k in keywords if k.strip()),
                     key=len, reverse=True)
    keyword_group = "|".join(escaped) or "part"
    return re.compile(
        rf"^\s*(?:#{{1,6}}\s*)?(?P<kw>{keyword_group})\s*"
        rf"(?P<num>[0-9]+|[ivxIVX]+|\S+)?\s*"
        rf"(?:[:\-–—.)\]]\s*)?(?P<title>.*)$",
        re.IGNORECASE | re.UNICODE,
    )


def _parse_number(raw: str | None) -> int | None:
    if not raw:
        return None
    token = raw.strip().strip(":-–—.)]").strip()
    if token.isdigit():
        return int(token)
    if token in _ARABIC_ORDINALS:
        return _ARABIC_ORDINALS[token]
    if token.lower() in _ROMAN:
        return _ROMAN[token.lower()]
    return None


def _looks_like_heading(line: str, pattern: re.Pattern[str]) -> re.Match[str] | None:
    stripped = line.strip()
    if not stripped or len(stripped) > _MAX_HEADING_CHARS:
        return None
    match = pattern.match(_normalise(stripped))
    if not match:
        return None
    # A keyword alone is not enough: require a number/ordinal, or a heading that
    # is clearly a title line (short, no sentence-ending punctuation).
    if _parse_number(match.group("num")) is not None:
        return match
    if match.group("num") is None and len(stripped) <= 40:
        return match
    return None


def parse_story_text(
    raw_text: str,
    keywords: Sequence[str] | None = None,
    fallback_chunk_paragraphs: int = 3,
    min_part_chars: int = 20,
    source_path: Path | None = None,
) -> Story:
    """Parses story text into Parts, falling back to paragraph chunking."""
    if not raw_text or not raw_text.strip():
        raise StoryParseError("Story text is empty.")

    keywords = list(keywords or ["part", "scene", "chapter"])
    pattern = _build_heading_pattern(keywords)
    lines = raw_text.splitlines()

    blocks: list[tuple[str, re.Match[str], list[str]]] = []
    preamble: list[str] = []
    for line in lines:
        match = _looks_like_heading(line, pattern)
        if match:
            blocks.append((line.strip(), match, []))
        elif blocks:
            blocks[-1][2].append(line)
        else:
            preamble.append(line)

    parts: list[Part] = []
    detection = "headings"

    for heading, match, body_lines in blocks:
        body = "\n".join(body_lines).strip("\n")
        title = (match.group("title") or "").strip()
        if len(body.strip()) < min_part_chars:
            log.debug("Skipping short block under heading %r", heading)
            continue
        index = len(parts) + 1
        parts.append(
            Part(
                index=index,
                text=body,
                heading=heading,
                title=title,
                label=heading or f"Part {index}",
                source_number=_parse_number(match.group("num")),
            )
        )

    if not parts:
        detection = "paragraph-chunks"
        parts = _chunk_paragraphs(raw_text, fallback_chunk_paragraphs, min_part_chars)

    if not parts:
        raise StoryParseError(
            "No usable parts found in the story file. Add 'Part 1:' style headings "
            "or make sure the file contains real paragraphs."
        )

    log.info("Parsed %d parts from story (%s).", len(parts), detection)
    return Story(parts=parts, source_path=source_path, detection=detection)


def _chunk_paragraphs(raw_text: str, per_chunk: int, min_part_chars: int) -> list[Part]:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", raw_text) if p.strip()]
    per_chunk = max(1, per_chunk)
    parts: list[Part] = []
    for start in range(0, len(paragraphs), per_chunk):
        body = "\n\n".join(paragraphs[start:start + per_chunk])
        if len(body) < min_part_chars:
            continue
        index = len(parts) + 1
        parts.append(Part(index=index, text=body, label=f"Part {index}"))
    return parts


def load_story(
    story_path: Path,
    keywords: Sequence[str] | None = None,
    fallback_chunk_paragraphs: int = 3,
    min_part_chars: int = 20,
) -> Story:
    """Reads the story file from disk (UTF-8, BOM tolerant) and parses it."""
    if not story_path.exists():
        raise StoryParseError(
            f"Story file not found: {story_path}\n"
            f"Put your story in that file, or point paths.story_file at another file."
        )
    raw_text = story_path.read_text(encoding="utf-8-sig")
    return parse_story_text(
        raw_text,
        keywords=keywords,
        fallback_chunk_paragraphs=fallback_chunk_paragraphs,
        min_part_chars=min_part_chars,
        source_path=story_path,
    )
