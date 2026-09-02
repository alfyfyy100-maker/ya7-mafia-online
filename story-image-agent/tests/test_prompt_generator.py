from pathlib import Path

from character_manager import CharacterBible
from prompt_generator import PromptGenerator, analyse_part, build_prompt, pick_focus_excerpt
from story_parser import parse_story_text

KEYWORDS = ["part", "الجزء"]

STORY = parse_story_text(
    "الجزء 1: الليل\n"
    "في الليل وقفت سارة أمام الباب تحمل رسالة، ونظرت سارة إلى الشارع بخوف.\n"
    "قالت سارة كلمة واحدة ثم دخلت الغرفة المظلمة.\n\n"
    "الجزء 2: الغروب\n"
    "عند الغروب صرخ ماجد في السوق، وركض ماجد بين الناس. قال ماجد إنه تأخر.\n",
    keywords=KEYWORDS,
)

STYLE = {
    "name": "Test Style",
    "medium": "digital painting",
    "aspect_ratio": "16:9",
    "negative": "no watermarks",
}


def _bible() -> CharacterBible:
    bible = CharacterBible(Path("unused.json"))
    bible.build_from_story(STORY)
    return bible


def test_analysis_reads_time_mood_and_action():
    analysis = analyse_part(STORY.parts[0])
    assert analysis.time_of_day == "night"
    assert "night" in analysis.lighting
    assert analysis.mood == "tense and fearful"
    assert analysis.expression

    second = analyse_part(STORY.parts[1])
    assert second.time_of_day == "sunset"
    assert "market" in second.setting


def test_prompt_contains_every_required_section():
    bible = _bible()
    part = STORY.parts[0]
    prompt = build_prompt(part, bible.characters_in_part(part), STYLE)
    for section in ("[VISUAL STYLE", "[CHARACTERS IN FRAME", "[SCENE]",
                    "[COMPOSITION]", "[SOURCE PASSAGE", "[DO NOT INCLUDE]"):
        assert section in prompt
    assert "16:9" in prompt
    assert "no written text" in prompt


def test_same_character_gets_identical_description_across_parts():
    bible = _bible()
    sara = bible.characters["سارة"]
    prompt_one = build_prompt(STORY.parts[0], [sara], STYLE)
    prompt_two = build_prompt(STORY.parts[1], [sara], STYLE)
    assert sara.visual_description() in prompt_one
    assert sara.visual_description() in prompt_two


def test_prompt_without_characters_still_renders():
    prompt = build_prompt(STORY.parts[0], [], STYLE)
    assert "No named character" in prompt


def test_negative_section_can_be_disabled():
    prompt = build_prompt(STORY.parts[0], [], STYLE, include_negative=False)
    assert "[DO NOT INCLUDE]" not in prompt


def test_excerpt_is_quoted_from_the_source_and_bounded():
    excerpt = pick_focus_excerpt(STORY.parts[0].text, max_chars=60)
    assert len(excerpt) <= 60
    assert excerpt.split()[0] in STORY.parts[0].text


def test_generator_writes_prompt_files(tmp_path: Path):
    generator = PromptGenerator(_bible(), STYLE, tmp_path / "prompts")
    prompt, analysis, characters = generator.generate_and_save(STORY.parts[0])
    path = tmp_path / "prompts" / "part_001.txt"
    assert path.exists()
    assert path.read_text(encoding="utf-8") == prompt
    assert analysis.time_of_day == "night"
    assert characters
