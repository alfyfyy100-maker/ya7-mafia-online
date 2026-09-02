from pathlib import Path

from character_manager import (
    Character,
    CharacterBible,
    build_character,
    detect_characters,
    extract_locations,
    extract_props,
)
from story_parser import parse_story_text

KEYWORDS = ["part", "الجزء", "جزء"]

STORY = parse_story_text(
    "الجزء 1: البداية\n"
    "قالت سارة لماجد إنها ستنتظر في الغرفة. نظرت سارة إلى الرسالة ثم جلست.\n"
    "قال ماجد إن الطريق طويل، ثم خرج ماجد إلى الشارع. سارة بقيت وحدها.\n\n"
    "الجزء 2: السوق\n"
    "مشى ماجد في السوق، وحملت سارة الحقيبة. قالت سارة إن الوقت تأخر يا ماجد.\n",
    keywords=KEYWORDS,
)


def test_detects_main_characters_only():
    names = {c.name for c in detect_characters(STORY, min_mentions=3)}
    assert "سارة" in names and "ماجد" in names
    assert not any(name.startswith("بال") or name.startswith("ال") for name in names)


def test_gender_cue_does_not_confuse_qal_and_qalat():
    characters = {c.name: c for c in detect_characters(STORY, min_mentions=3)}
    assert characters["سارة"].gender == "female"
    assert characters["ماجد"].gender == "male"


def test_character_identity_is_deterministic():
    first = build_character("سارة", gender="female")
    second = build_character("سارة", gender="female")
    assert first.visual_description() == second.visual_description()
    assert build_character("ماجد").visual_description() != first.visual_description()


def test_visual_description_covers_every_required_trait():
    character = build_character("Sara", gender="female")
    description = character.visual_description()
    for attribute in (character.age, character.face, character.skin,
                      character.hair, character.eyes, character.clothing):
        assert attribute in description


def test_bible_round_trip_and_manual_edits_survive(tmp_path: Path):
    path = tmp_path / "bible.json"
    bible = CharacterBible(path)
    bible.build_from_story(STORY)
    bible.characters["سارة"].hair = "bright silver hair, shaved on one side"
    bible.characters["سارة"].manual = True
    bible.save()

    reloaded = CharacterBible(path).load()
    reloaded.build_from_story(STORY)  # a later run must not clobber the edit
    assert reloaded.characters["سارة"].hair == "bright silver hair, shaved on one side"


def test_rebuild_overwrites_auto_entries_but_keeps_manual(tmp_path: Path):
    path = tmp_path / "bible.json"
    bible = CharacterBible(path)
    bible.build_from_story(STORY)
    bible.characters["سارة"].hair = "auto value to be replaced"
    bible.characters["Ghost"] = Character(name="Ghost", display_name="Ghost", manual=True)
    bible.build_from_story(STORY, overwrite=True)
    assert bible.characters["سارة"].hair != "auto value to be replaced"
    assert "Ghost" in bible.characters


def test_characters_in_part_returns_only_present_characters():
    bible = CharacterBible(Path("unused.json"))
    bible.build_from_story(STORY)
    present = {c.name for c in bible.characters_in_part(STORY.parts[1])}
    assert "ماجد" in present


def test_location_and_prop_extraction():
    assert "a market" in extract_locations("مشى في السوق المزدحم")
    assert "a letter" in extract_props("حملت رسالة قديمة")
