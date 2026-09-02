"""Prompt generation: one detailed, style-locked image prompt per Part.

A prompt is assembled from four sources:
  1. the Style Bible (config/config.json) — identical in every prompt,
  2. the Character Bible — the *same* fixed description for a character in
     every part they appear in, which is what keeps faces consistent,
  3. a heuristic scene analysis of the part (setting, time, light, mood, action),
  4. a verbatim excerpt of the original story text, so the model gets the real
     scene and not only our summary of it.

The original story text is never edited — only excerpted.
"""

from __future__ import annotations

import re
import textwrap
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

from character_manager import Character, CharacterBible, extract_locations, extract_props
from logger import get_logger
from story_parser import Part

log = get_logger("prompts")

_TIME_LEXICON: list[tuple[tuple[str, ...], str, str]] = [
    (("فجر", "الفجر", "dawn", "sunrise"), "dawn",
     "cool blue pre-dawn light with a thin warm band on the horizon"),
    (("صباح", "الصباح", "morning", "ضحى"), "morning",
     "clear morning light, long soft shadows"),
    (("ظهر", "الظهيرة", "noon", "midday"), "midday",
     "harsh overhead sunlight, short hard shadows"),
    (("عصر", "afternoon"), "late afternoon",
     "warm low afternoon sun, golden rim light"),
    (("غروب", "الغروب", "sunset", "dusk", "مغرب"), "sunset",
     "golden hour light, long amber shadows, glowing sky"),
    (("ليل", "الليل", "منتصف الليل", "night", "midnight", "مساء"), "night",
     "low-key night lighting, cool moonlight and warm practical lamps"),
]

_MOOD_LEXICON: list[tuple[tuple[str, ...], str]] = [
    (("خوف", "رعب", "فزع", "ارتجف", "fear", "terror", "afraid"), "tense and fearful"),
    (("حزن", "بكى", "بكت", "دموع", "sad", "tears", "grief"), "sorrowful and heavy"),
    (("غضب", "صرخ", "صرخت", "انفجر", "anger", "rage", "shouted"), "angry and volatile"),
    (("فرح", "ضحك", "ضحكت", "ابتسم", "joy", "laugh", "smile"), "warm and hopeful"),
    (("توتر", "قلق", "انتظر", "tension", "anxious", "nervous"), "anxious and uneasy"),
    (("حب", "شوق", "love", "longing"), "intimate and tender"),
    (("موت", "دم", "جثة", "death", "blood", "corpse"), "grim and ominous"),
    (("سر", "خيانة", "همس", "secret", "betrayal", "whisper"), "secretive and charged"),
]

_ACTION_LEXICON: list[tuple[tuple[str, ...], str]] = [
    (("ركض", "ركضت", "هرب", "هربت", "ran", "fled"), "running, body leaning forward mid-stride"),
    (("وقف", "وقفت", "stood", "standing"), "standing still, weight on one leg"),
    (("جلس", "جلست", "sat", "sitting"), "seated, shoulders drawn in"),
    (("نظر", "نظرت", "حدّق", "stared", "looked"), "locked in a direct stare"),
    (("صرخ", "صرخت", "shouted", "screamed"), "mouth open mid-shout, neck tensed"),
    (("همس", "همست", "whispered"), "leaning close, whispering"),
    (("بكى", "بكت", "cried", "wept"), "head lowered, tears on the cheeks"),
    (("فتح", "فتحت", "طرق", "opened", "knocked"), "reaching out with one hand"),
    (("مشى", "مشت", "walked", "walking"), "walking, mid-step"),
    (("حمل", "حملت", "أمسك", "held", "carrying"), "gripping an object with both hands"),
]

_EXPRESSION_BY_MOOD = {
    "tense and fearful": "wide eyes, tight jaw, drawn brows",
    "sorrowful and heavy": "downcast eyes, slack mouth, heavy eyelids",
    "angry and volatile": "furrowed brows, flared nostrils, clenched jaw",
    "warm and hopeful": "soft eyes, an open unforced smile",
    "anxious and uneasy": "eyes darting aside, lips pressed thin",
    "intimate and tender": "half-lidded eyes, a gentle expression",
    "grim and ominous": "hollow stare, colourless expression",
    "secretive and charged": "narrowed eyes, a guarded half-turn of the head",
    "quiet and contemplative": "calm, unfocused gaze, relaxed mouth",
}

_CAMERA_CHOICES = [
    "wide establishing shot, eye-level camera",
    "medium shot, slight low angle for presence",
    "close-up portrait framing, eye-level",
    "over-the-shoulder shot with shallow depth of field",
    "medium-wide two-shot, balanced framing",
    "high-angle shot looking down on the subject",
]

_COMPOSITION_CHOICES = [
    "subject on the left third, negative space to the right",
    "centred symmetrical composition with strong leading lines",
    "subject framed by a doorway or window edge",
    "foreground element blurred, subject in the mid-ground",
    "rule-of-thirds placement with a deep background",
    "tight framing, environment implied at the edges",
]

_DEFAULT_MOOD = "quiet and contemplative"


@dataclass
class SceneAnalysis:
    """What the agent decided the part should look like."""

    setting: str = "an unspecified interior"
    time_of_day: str = "unspecified time"
    lighting: str = "soft naturalistic lighting"
    mood: str = _DEFAULT_MOOD
    expression: str = ""
    action: str = "in a still, held moment"
    props: list[str] = field(default_factory=list)
    camera: str = _CAMERA_CHOICES[0]
    composition: str = _COMPOSITION_CHOICES[0]
    excerpt: str = ""

    def to_dict(self) -> dict[str, object]:
        return {
            "setting": self.setting,
            "time_of_day": self.time_of_day,
            "lighting": self.lighting,
            "mood": self.mood,
            "expression": self.expression,
            "action": self.action,
            "props": self.props,
            "camera": self.camera,
            "composition": self.composition,
        }


def _match_lexicon(text: str, lexicon: Sequence[tuple[tuple[str, ...], ...]]):
    for entry in lexicon:
        keywords = entry[0]
        if any(keyword in text for keyword in keywords):
            return entry
    return None


def pick_focus_excerpt(text: str, max_chars: int) -> str:
    """Chooses the most visual passage of the part as the scene to draw.

    Sentences are scored by concrete visual vocabulary (places, light, motion,
    objects); the highest scoring window is returned, trimmed to `max_chars`.
    """
    sentences = [s.strip() for s in re.split(r"(?<=[.!?؟…])\s+|\n+", text) if s.strip()]
    if not sentences:
        return text[:max_chars]

    visual_cues = ("نظر", "وقف", "دخل", "خرج", "فتح", "أمسك", "ضوء", "ظل", "وجه",
                   "عين", "يد", "باب", "شارع", "غرفة", "سماء", "نار", "دم", "مطر",
                   "looked", "stood", "entered", "opened", "light", "shadow", "face",
                   "eyes", "hand", "door", "street", "room", "sky", "fire", "rain")

    def score(sentence: str) -> int:
        return sum(1 for cue in visual_cues if cue in sentence) + min(len(sentence) // 80, 2)

    best_index = max(range(len(sentences)), key=lambda i: score(sentences[i]))
    window: list[str] = [sentences[best_index]]
    left, right = best_index - 1, best_index + 1
    while len(" ".join(window)) < max_chars and (left >= 0 or right < len(sentences)):
        if left >= 0 and len(" ".join(window)) + len(sentences[left]) < max_chars:
            window.insert(0, sentences[left])
            left -= 1
        elif right < len(sentences) and len(" ".join(window)) + len(sentences[right]) < max_chars:
            window.append(sentences[right])
            right += 1
        else:
            break
    return " ".join(window)[:max_chars].strip()


def analyse_part(part: Part, max_excerpt_chars: int = 700) -> SceneAnalysis:
    """Derives setting, time, light, mood, action and framing from the part text."""
    text = part.text
    lowered = text.lower()

    locations = extract_locations(text, limit=2)
    setting = " and ".join(locations) if locations else "an unspecified setting"

    time_entry = _match_lexicon(lowered, _TIME_LEXICON)
    time_of_day = time_entry[1] if time_entry else "unspecified time"
    lighting = time_entry[2] if time_entry else "soft naturalistic lighting"

    mood_entry = _match_lexicon(lowered, _MOOD_LEXICON)
    mood = mood_entry[1] if mood_entry else _DEFAULT_MOOD

    action_entry = _match_lexicon(lowered, _ACTION_LEXICON)
    action = action_entry[1] if action_entry else "in a still, held moment"

    # Framing varies per part but is stable across runs (index-derived, not random).
    camera = _CAMERA_CHOICES[(part.index - 1) % len(_CAMERA_CHOICES)]
    composition = _COMPOSITION_CHOICES[(part.index * 2 - 1) % len(_COMPOSITION_CHOICES)]

    return SceneAnalysis(
        setting=setting,
        time_of_day=time_of_day,
        lighting=lighting,
        mood=mood,
        expression=_EXPRESSION_BY_MOOD.get(mood, "a natural, readable expression"),
        action=action,
        props=extract_props(text, limit=3),
        camera=camera,
        composition=composition,
        excerpt=pick_focus_excerpt(text, max_excerpt_chars),
    )


def _style_block(style: dict[str, object]) -> str:
    order = ["name", "medium", "rendering", "color_palette", "lighting_style",
             "camera", "aspect_ratio", "quality_tags", "extra_notes"]
    lines = []
    for key in order:
        value = str(style.get(key, "")).strip()
        if value:
            lines.append(f"- {key.replace('_', ' ')}: {value}")
    return "\n".join(lines)


def build_prompt(
    part: Part,
    characters: Sequence[Character],
    style: dict[str, object],
    analysis: SceneAnalysis | None = None,
    include_negative: bool = True,
) -> str:
    """Assembles the final prompt text sent to Gemini for one part."""
    analysis = analysis or analyse_part(part)

    if characters:
        character_lines = "\n".join(
            f"- {c.visual_description()}" for c in characters
        )
        cast = ", ".join(c.display_name or c.name for c in characters)
    else:
        character_lines = "- No named character is identifiable in this part; " \
                          "depict the environment itself as the subject."
        cast = "no named characters"

    props = ", ".join(analysis.props) if analysis.props else "none in particular"

    sections = [
        "Create ONE single illustrated image for this scene of an ongoing story.",
        "",
        "[VISUAL STYLE — identical for every image in this story]",
        _style_block(style),
        "",
        "[CHARACTERS IN FRAME — keep these exact appearances, do not redesign them]",
        character_lines,
        "",
        "[SCENE]",
        f"- part: {part.label or part.slug}"
        + (f" — {part.title}" if part.title else ""),
        f"- who is in frame: {cast}",
        f"- setting: {analysis.setting}",
        f"- time of day: {analysis.time_of_day}",
        f"- lighting: {analysis.lighting}",
        f"- mood / atmosphere: {analysis.mood}",
        f"- character action / posture: {analysis.action}",
        f"- facial expressions: {analysis.expression}",
        f"- important objects in the scene: {props}",
        "",
        "[COMPOSITION]",
        f"- camera: {analysis.camera}",
        f"- framing: {analysis.composition}",
        f"- aspect ratio: {style.get('aspect_ratio', '16:9')}",
        "",
        "[SOURCE PASSAGE — the moment to illustrate, quoted from the story]",
        analysis.excerpt,
    ]

    if include_negative:
        negative = str(style.get("negative", "")).strip()
        sections += [
            "",
            "[DO NOT INCLUDE]",
            "- no written text, letters, captions, subtitles or speech bubbles in the image, "
            "unless a sign or letter is explicitly named above as an important object",
            f"- {negative}" if negative else "- no watermarks or logos",
            "- do not change the characters' faces, hair, eye colour or clothing from the "
            "descriptions above",
        ]

    return "\n".join(sections).strip()


class PromptGenerator:
    """Generates and persists one prompt per part."""

    def __init__(self, bible: CharacterBible, style: dict[str, object],
                 prompts_dir: Path, max_excerpt_chars: int = 700,
                 include_negative: bool = True, max_characters: int = 4) -> None:
        self.bible = bible
        self.style = style
        self.prompts_dir = prompts_dir
        self.max_excerpt_chars = max_excerpt_chars
        self.include_negative = include_negative
        self.max_characters = max_characters

    def generate(self, part: Part) -> tuple[str, SceneAnalysis, list[Character]]:
        characters = self.bible.characters_in_part(part, limit=self.max_characters)
        analysis = analyse_part(part, max_excerpt_chars=self.max_excerpt_chars)
        prompt = build_prompt(part, characters, self.style, analysis,
                              include_negative=self.include_negative)
        return prompt, analysis, characters

    def prompt_path(self, part: Part) -> Path:
        return self.prompts_dir / f"{part.slug}.txt"

    def save(self, part: Part, prompt: str) -> Path:
        self.prompts_dir.mkdir(parents=True, exist_ok=True)
        path = self.prompt_path(part)
        path.write_text(prompt, encoding="utf-8")
        log.debug("Prompt for %s saved to %s", part.slug, path)
        return path

    def generate_and_save(self, part: Part) -> tuple[str, SceneAnalysis, list[Character]]:
        prompt, analysis, characters = self.generate(part)
        self.save(part, prompt)
        return prompt, analysis, characters

    @staticmethod
    def preview(prompt: str, width: int = 100) -> str:
        return "\n".join(textwrap.wrap(prompt, width=width)[:20])
