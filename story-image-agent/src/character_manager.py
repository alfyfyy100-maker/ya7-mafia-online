"""Character Bible: stable visual identities for every recurring character.

The agent runs fully offline (no LLM API is used anywhere in this project), so
characters are detected with language-aware heuristics — dialogue cues, vocative
markers, name frequency — and each detected character is given a *deterministic*
visual identity derived from a hash of its name. Determinism is the point: the
same character always gets the same face, hair, eyes and wardrobe, in every part
and on every re-run, which is what keeps the generated images consistent.

The bible is written to `output/character_bible.json`. That file is the source of
truth: edit it by hand to correct a description and the agent will keep your
version — regeneration never overwrites an existing entry unless you ask for it.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

from logger import get_logger
from story_parser import Part, Story

log = get_logger("characters")

# --- lexicons ------------------------------------------------------------

_ARABIC_STOPWORDS = {
    "في", "من", "على", "إلى", "الى", "عن", "مع", "هذا", "هذه", "ذلك", "تلك",
    "التي", "الذي", "كان", "كانت", "قال", "قالت", "ثم", "كل", "بعد", "قبل",
    "حتى", "لكن", "لأن", "لان", "أن", "ان", "إن", "لا", "ما", "هو", "هي",
    "هم", "أنا", "انا", "أنت", "انت", "نحن", "كما", "عند", "عندما", "بين",
    "حين", "لم", "لن", "قد", "كي", "أو", "او", "و", "يا", "بل", "إذا", "اذا",
    "شيء", "شيئا", "يوم", "ليل", "نهار", "وقت", "مرة", "الآن", "الان",
    "نفسه", "نفسها", "أيضا", "ايضا", "فقط", "جدا", "جداً", "غير", "دون",
    "صوت", "عين", "عيون", "وجه", "يد", "قلب", "باب", "طريق", "مكان",
    "واحد", "واحدا", "واحدة", "شيئا", "شييا", "أخرى", "اخرى", "مرات",
    "ثلاث", "بعيدا", "طويلا", "قليلا", "أحد", "احد", "رجل", "امرأة",
    "الرجل", "المرأة", "ولد", "بنت", "طفل", "أمام", "امام", "خلف", "تحت", "فوق",
}

_ENGLISH_STOPWORDS = {
    "The", "A", "An", "And", "But", "So", "Then", "When", "While", "After",
    "Before", "He", "She", "They", "It", "I", "We", "You", "His", "Her",
    "Their", "This", "That", "There", "Here", "In", "On", "At", "To", "From",
    "With", "Of", "For", "As", "By", "If", "No", "Not", "Yes", "Now", "Later",
    "Chapter", "Part", "Scene", "Suddenly", "Finally", "Meanwhile", "Inside",
    "Outside", "Above", "Below", "Once", "Every", "Some", "One", "Two",
}

_MALE_VERBS = ("قال", "همس", "صرخ", "نظر", "ابتسم", "جلس", "وقف", "خرج", "دخل",
               "مشى", "حمل", "فتح", "ركض", "صعد", "عاد")
_FEMALE_VERBS = ("قالت", "همست", "صرخت", "نظرت", "ابتسمت", "جلست", "وقفت", "خرجت",
                 "دخلت", "مشت", "حملت", "فتحت", "ركضت", "صعدت", "عادت")
_MALE_WORDS = ("he", "his", "him", "man", "boy", "father", "brother")
_FEMALE_WORDS = ("she", "her", "hers", "woman", "girl", "mother", "sister")

_LOCATION_LEXICON = {
    "غرفة": "a room", "الغرفة": "a room", "بيت": "a house", "البيت": "a house",
    "منزل": "a house", "المنزل": "a house", "مقهى": "a cafe", "المقهى": "a cafe",
    "شارع": "a street", "الشارع": "a street", "سوق": "a market", "السوق": "a market",
    "مدرسة": "a school", "المدرسة": "a school", "مستشفى": "a hospital",
    "المستشفى": "a hospital", "قصر": "a palace", "القصر": "a palace",
    "قاعة": "a hall", "القاعة": "a hall", "حديقة": "a garden", "الحديقة": "a garden",
    "صحراء": "a desert", "الصحراء": "a desert", "بحر": "the sea", "البحر": "the sea",
    "شاطئ": "a beach", "الشاطئ": "a beach", "جبل": "a mountain", "الجبل": "a mountain",
    "سيارة": "inside a car", "السيارة": "inside a car", "مكتب": "an office",
    "المكتب": "an office", "سجن": "a prison", "السجن": "a prison",
    "مطبخ": "a kitchen", "المطبخ": "a kitchen", "سطح": "a rooftop", "السطح": "a rooftop",
    "زقاق": "a narrow alley", "الزقاق": "a narrow alley", "مسجد": "a mosque",
    "المسجد": "a mosque", "قرية": "a village", "القرية": "a village",
    "مدينة": "a city", "المدينة": "a city", "غابة": "a forest", "الغابة": "a forest",
    "نهر": "a river", "النهر": "a river", "ميناء": "a harbour", "الميناء": "a harbour",
    "room": "a room", "house": "a house", "cafe": "a cafe", "street": "a street",
    "market": "a market", "school": "a school", "hospital": "a hospital",
    "palace": "a palace", "hall": "a hall", "garden": "a garden", "desert": "a desert",
    "sea": "the sea", "beach": "a beach", "mountain": "a mountain", "car": "inside a car",
    "office": "an office", "prison": "a prison", "kitchen": "a kitchen",
    "rooftop": "a rooftop", "alley": "a narrow alley", "village": "a village",
    "city": "a city", "forest": "a forest", "river": "a river", "harbour": "a harbour",
}

_PROP_LEXICON = {
    "رسالة": "a letter", "خطاب": "a letter", "هاتف": "a phone", "الهاتف": "a phone",
    "سكين": "a knife", "مسدس": "a handgun", "سيف": "a sword", "كتاب": "a book",
    "مفتاح": "a key", "صندوق": "a box", "مرآة": "a mirror", "شمعة": "a candle",
    "ساعة": "a clock", "قهوة": "a cup of coffee", "شاي": "a glass of tea",
    "حقيبة": "a bag", "خريطة": "a map", "صورة": "an old photograph",
    "letter": "a letter", "phone": "a phone", "knife": "a knife", "gun": "a handgun",
    "sword": "a sword", "book": "a book", "key": "a key", "box": "a box",
    "mirror": "a mirror", "candle": "a candle", "clock": "a clock",
    "coffee": "a cup of coffee", "bag": "a bag", "map": "a map",
    "photograph": "an old photograph",
}

# --- deterministic appearance palettes ------------------------------------

_FACE_SHAPES = ["an oval face with soft cheekbones", "a square jawline and broad forehead",
                "a narrow angular face with high cheekbones", "a round face with full cheeks",
                "a long face with a straight nose", "a heart-shaped face with a pointed chin"]
_SKIN_TONES = ["light olive skin", "warm tan skin", "deep brown skin",
               "fair skin with a faint flush", "medium bronze skin", "dark umber skin"]
_HAIR_MALE = ["short black hair, neatly combed", "thick dark brown hair, slightly messy",
              "close-cropped greying hair", "wavy black hair to the ears",
              "straight jet-black hair parted on the side", "short curly dark hair"]
_HAIR_FEMALE = ["long straight black hair past the shoulders",
                "dark brown hair tied in a low bun", "shoulder-length wavy chestnut hair",
                "long black hair in a single braid", "curly dark hair framing the face",
                "auburn hair pinned back from the forehead"]
_EYES = ["dark brown eyes", "deep black eyes", "hazel eyes", "grey-green eyes",
         "amber eyes", "light brown eyes"]
_BUILD = ["slim build, average height", "tall and lean", "broad-shouldered and sturdy",
          "short and compact", "athletic build", "slight and wiry"]
_CLOTHES_MALE = ["a plain dark shirt with rolled sleeves and grey trousers",
                 "a worn brown jacket over a beige shirt",
                 "a simple white thobe", "a charcoal suit without a tie",
                 "a grey knitted sweater and dark jeans",
                 "a faded olive work shirt and canvas trousers"]
_CLOTHES_FEMALE = ["a long dark blue dress with simple embroidery",
                   "a beige blouse and a long grey skirt",
                   "a black abaya with a deep red trim",
                   "a soft cream tunic over dark trousers",
                   "a muted green dress with long sleeves",
                   "a plain white shirt and a long brown skirt"]
_ACCESSORIES = ["a thin silver ring on the right hand", "an old leather wristwatch",
                "a small pendant on a leather cord", "thin wire-rimmed glasses",
                "a faded scarf around the neck", "no distinctive accessories"]
_TRAITS = ["a small scar above the left eyebrow", "a calm, steady gaze",
           "a permanent tired shadow under the eyes", "a faint mole on the right cheek",
           "slightly furrowed brows", "a habitual half-smile"]
_AGES = ["around 20 years old", "in their mid-20s", "around 30 years old",
         "in their late 30s", "around 45 years old", "in their late 50s"]


@dataclass
class Character:
    """One entry of the Character Bible — a fixed visual identity."""

    name: str
    display_name: str = ""
    gender: str = "unspecified"
    age: str = "around 30 years old"
    face: str = ""
    skin: str = ""
    hair: str = ""
    eyes: str = ""
    build: str = ""
    clothing: str = ""
    accessories: str = ""
    fixed_traits: str = ""
    mentions: int = 0
    appears_in: list[int] = field(default_factory=list)
    manual: bool = False

    def visual_description(self) -> str:
        """The exact sentence injected into every prompt this character is in."""
        pieces = [
            f"{self.display_name or self.name}",
            f"({self.gender}, {self.age})" if self.gender != "unspecified" else f"({self.age})",
            f"{self.face}", f"{self.skin}", f"{self.hair}", f"{self.eyes}",
            f"{self.build}", f"wearing {self.clothing}",
        ]
        if self.accessories and "no distinctive" not in self.accessories:
            pieces.append(f"with {self.accessories}")
        if self.fixed_traits:
            pieces.append(self.fixed_traits)
        return ", ".join(p for p in pieces if p)

    def to_dict(self) -> dict[str, object]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> "Character":
        allowed = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in data.items() if k in allowed})


def _seeded_pick(name: str, salt: str, options: Sequence[str]) -> str:
    digest = hashlib.sha256(f"{name}|{salt}".encode("utf-8")).hexdigest()
    return options[int(digest[:8], 16) % len(options)]


_DIACRITICS_RE = re.compile(r"[\u064B-\u0652\u0670\u06D6-\u06ED\u0640]")


def _strip_diacritics(text: str) -> str:
    """Removes Arabic vowel marks and tatweel while keeping letters intact.

    NFKD is deliberately avoided here: it decomposes hamza carriers (ئ → ي + ٔ)
    and would silently turn one word into another.
    """
    return _DIACRITICS_RE.sub("", unicodedata.normalize("NFC", text))


def _count_cues(blob: str, cues: Sequence[str]) -> int:
    """Counts whole-word cue hits so that 'قال' does not also match 'قالت'."""
    return sum(len(re.findall(rf"\b{re.escape(cue)}\b", blob)) for cue in cues)


def _directed_cue_score(name: str, text: str, verbs: Sequence[str]) -> int:
    """Counts verbs bound to *this* name — 'قالت سارة' / 'سارة قالت'.

    Only adjacency counts, so a cue that belongs to another character standing
    nearby in the same sentence cannot flip this character's gender.
    """
    escaped_name = re.escape(name)
    total = 0
    for verb in verbs:
        verb_re = re.escape(verb)
        total += len(re.findall(rf"\b{verb_re}\s+{escaped_name}\b", text))
        total += len(re.findall(rf"\b{escaped_name}\s+{verb_re}\b", text))
    return total


def _guess_gender(name: str, text: str, contexts: Sequence[str] = ()) -> str:
    """Infers gender from verbs bound to the name, then from name morphology."""
    female = _directed_cue_score(name, text, _FEMALE_VERBS) * 2
    male = _directed_cue_score(name, text, _MALE_VERBS) * 2

    if not female and not male:
        blob = " ".join(contexts).lower()
        female += _count_cues(blob, _FEMALE_WORDS)
        male += _count_cues(blob, _MALE_WORDS)

    if female == male and name.endswith(("ة", "اء", "ى")) and not name.endswith("اه"):
        female += 1

    if female > male:
        return "female"
    if male > female:
        return "male"
    return "unspecified"


_ARABIC_NAME_RE = re.compile(r"[ء-ي][ء-ي]{2,}")
_LATIN_NAME_RE = re.compile(r"\b[A-Z][a-z]{2,}\b")
_CUE_RE = re.compile(
    r"\b(?:قال|قالت|همس|همست|صاح|صاحت|نادى|نادت|سأل|سألت|أجاب|أجابت|ردّ|ردت|يا)\s+"
    r"(?P<name>[ء-ي]{3,})\b"
)

# و/ف/ب/ل/ك prefixes glued to a definite article ("بالرجل") mark a common noun.
_ARTICLE_PREFIX_RE = re.compile(r"^(?:[وفبلك]?ال|لل)")


def detect_characters(story: Story, min_mentions: int = 3, max_characters: int = 12) -> list[Character]:
    """Finds likely character names and builds a deterministic visual identity."""
    counts: dict[str, int] = {}
    cue_bonus: dict[str, int] = {}
    contexts: dict[str, list[str]] = {}
    appearances: dict[str, set[int]] = {}
    full_text = _strip_diacritics("\n".join(part.text for part in story.parts))

    for part in story.parts:
        text = part.text
        flat = _strip_diacritics(text)
        candidates: list[str] = []

        for match in _CUE_RE.finditer(flat):
            name = match.group("name")
            cue_bonus[name] = cue_bonus.get(name, 0) + 3
            candidates.append(name)
        for match in re.finditer(r"^\s*([ء-يA-Za-z ]{2,25}?)\s*:", flat, re.MULTILINE):
            speaker = match.group(1).strip()
            if 2 < len(speaker) <= 25 and " " not in speaker.strip():
                cue_bonus[speaker] = cue_bonus.get(speaker, 0) + 3
                candidates.append(speaker)

        candidates.extend(_ARABIC_NAME_RE.findall(flat))
        candidates.extend(_LATIN_NAME_RE.findall(text))

        for raw in candidates:
            name = raw.strip()
            if not _is_plausible_name(name):
                continue
            counts[name] = counts.get(name, 0) + 1
            appearances.setdefault(name, set()).add(part.index)
            if len(contexts.setdefault(name, [])) < 12:
                window = _context_window(flat, name)
                if window:
                    contexts[name].append(window)

    scored = sorted(
        counts.items(),
        key=lambda item: (item[1] + cue_bonus.get(item[0], 0), len(appearances.get(item[0], ()))),
        reverse=True,
    )

    characters: list[Character] = []
    for name, count in scored:
        bonus = cue_bonus.get(name, 0)
        total_score = count + bonus
        # A name needs either several plain mentions or a real dialogue cue;
        # one incidental noun match is never promoted to a character.
        if total_score < min_mentions or (bonus == 0 and count < min_mentions):
            continue
        if _is_substring_of_existing(name, [c.name for c in characters]):
            continue
        characters.append(
            build_character(
                name,
                gender=_guess_gender(name, full_text, contexts.get(name, [])),
                mentions=count,
                appears_in=sorted(appearances.get(name, ())),
            )
        )
        if len(characters) >= max_characters:
            break

    log.info("Detected %d characters: %s", len(characters),
             ", ".join(c.name for c in characters) or "none")
    return characters


def _is_plausible_name(name: str) -> bool:
    if len(name) < 3 or len(name) > 25:
        return False
    if name in _ARABIC_STOPWORDS or name in _ENGLISH_STOPWORDS:
        return False
    if _ARTICLE_PREFIX_RE.match(name) and len(name) > 4:
        return False  # definite article ⇒ almost always a common noun
    if any(ch.isdigit() for ch in name):
        return False
    return True


def _is_substring_of_existing(name: str, existing: Iterable[str]) -> bool:
    return any(name != other and (name in other or other in name) for other in existing)


def _context_window(text: str, name: str, radius: int = 60) -> str:
    position = text.find(name)
    if position < 0:
        return ""
    return text[max(0, position - radius): position + len(name) + radius]


def build_character(name: str, gender: str = "unspecified", mentions: int = 0,
                    appears_in: Sequence[int] | None = None) -> Character:
    """Creates a deterministic visual identity for a name."""
    female = gender == "female"
    return Character(
        name=name,
        display_name=name,
        gender=gender,
        age=_seeded_pick(name, "age", _AGES),
        face=_seeded_pick(name, "face", _FACE_SHAPES),
        skin=_seeded_pick(name, "skin", _SKIN_TONES),
        hair=_seeded_pick(name, "hair", _HAIR_FEMALE if female else _HAIR_MALE),
        eyes=_seeded_pick(name, "eyes", _EYES),
        build=_seeded_pick(name, "build", _BUILD),
        clothing=_seeded_pick(name, "clothes", _CLOTHES_FEMALE if female else _CLOTHES_MALE),
        accessories=_seeded_pick(name, "acc", _ACCESSORIES),
        fixed_traits=_seeded_pick(name, "trait", _TRAITS),
        mentions=mentions,
        appears_in=list(appears_in or []),
    )


def extract_locations(text: str, limit: int = 3) -> list[str]:
    return _extract_from_lexicon(text, _LOCATION_LEXICON, limit)


def extract_props(text: str, limit: int = 4) -> list[str]:
    return _extract_from_lexicon(text, _PROP_LEXICON, limit)


def _extract_from_lexicon(text: str, lexicon: dict[str, str], limit: int) -> list[str]:
    flat = _strip_diacritics(text).lower()
    found: list[str] = []
    for keyword, english in lexicon.items():
        if keyword.lower() in flat and english not in found:
            found.append(english)
        if len(found) >= limit:
            break
    return found


class CharacterBible:
    """Loads, merges and saves the character bible file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.characters: dict[str, Character] = {}
        self.style_notes: str = ""

    # -- persistence ------------------------------------------------------
    def load(self) -> "CharacterBible":
        if not self.path.exists():
            return self
        data = json.loads(self.path.read_text(encoding="utf-8"))
        for entry in data.get("characters", []):
            character = Character.from_dict(entry)
            self.characters[character.name] = character
        self.style_notes = data.get("style_notes", "")
        log.info("Loaded character bible with %d entries.", len(self.characters))
        return self

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "_note": "Edit any field by hand; the agent never overwrites an existing "
                     "character unless you rebuild the bible with --rebuild-bible.",
            "style_notes": self.style_notes,
            "characters": [c.to_dict() for c in self.characters.values()],
        }
        self.path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        log.info("Character bible saved to %s", self.path)

    # -- building ---------------------------------------------------------
    def merge(self, detected: Sequence[Character], overwrite: bool = False) -> None:
        for character in detected:
            existing = self.characters.get(character.name)
            if existing and not overwrite:
                existing.mentions = character.mentions or existing.mentions
                existing.appears_in = character.appears_in or existing.appears_in
                continue
            self.characters[character.name] = character

    def build_from_story(self, story: Story, overwrite: bool = False,
                         min_mentions: int = 3, max_characters: int = 12) -> list[Character]:
        detected = detect_characters(story, min_mentions=min_mentions,
                                     max_characters=max_characters)
        if overwrite:
            # A rebuild also drops stale auto-detected entries; anything the user
            # marked "manual": true in the JSON survives.
            detected_names = {c.name for c in detected}
            self.characters = {
                name: character for name, character in self.characters.items()
                if character.manual or name in detected_names
            }
        self.merge(detected, overwrite=overwrite)
        return list(self.characters.values())

    # -- queries ----------------------------------------------------------
    def characters_in_part(self, part: Part, limit: int = 4) -> list[Character]:
        """Returns the characters that actually appear in this part, most prominent first."""
        flat = _strip_diacritics(part.text)
        present: list[tuple[int, Character]] = []
        for character in self.characters.values():
            occurrences = flat.count(_strip_diacritics(character.name))
            if occurrences:
                present.append((occurrences, character))
        present.sort(key=lambda item: item[0], reverse=True)
        return [character for _, character in present[:limit]]

    def __len__(self) -> int:
        return len(self.characters)
