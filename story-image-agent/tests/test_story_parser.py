from pathlib import Path

import pytest

from story_parser import StoryParseError, load_story, parse_story_text

KEYWORDS = ["part", "scene", "chapter", "جزء", "الجزء", "مشهد", "المشهد", "فصل", "الفصل"]


def test_parses_english_part_headings():
    story = parse_story_text(
        "Part 1: The Letter\nSara stood at the door in the dark street.\n\n"
        "Part 2: Majid\nMajid knocked three times and waited for an answer.",
        keywords=KEYWORDS,
    )
    assert story.detection == "headings"
    assert [p.index for p in story.parts] == [1, 2]
    assert story.parts[0].title == "The Letter"
    assert "Sara stood" in story.parts[0].text
    assert "Part 1" not in story.parts[0].text  # heading is not part of the body


def test_parses_arabic_headings_with_arabic_digits():
    story = parse_story_text(
        "الجزء ١: الرسالة\nوقفت سارة أمام الباب في الليل تنتظر أحدًا.\n\n"
        "المشهد ٢\nخرجت إلى الشارع ومشت وحدها حتى الفجر.",
        keywords=KEYWORDS,
    )
    assert len(story) == 2
    assert story.parts[0].source_number == 1
    assert story.parts[1].source_number == 2


def test_scene_and_chapter_keywords_are_accepted():
    story = parse_story_text(
        "Chapter 1\nA long opening paragraph that describes the empty room.\n\n"
        "Scene 2\nAnother paragraph describing the street outside at night.",
        keywords=KEYWORDS,
    )
    assert len(story) == 2


def test_falls_back_to_paragraph_chunks_without_headings():
    text = "\n\n".join(f"Paragraph number {i} with enough characters to count."
                       for i in range(1, 7))
    story = parse_story_text(text, keywords=KEYWORDS, fallback_chunk_paragraphs=3)
    assert story.detection == "paragraph-chunks"
    assert len(story) == 2


def test_original_text_is_preserved_verbatim():
    body = "وقفت سارة أمام الباب.\nثم دخلت ببطء شديد."
    story = parse_story_text(f"الجزء 1: البداية\n{body}", keywords=KEYWORDS)
    assert story.parts[0].text == body


def test_empty_story_raises():
    with pytest.raises(StoryParseError):
        parse_story_text("   \n  \n")


def test_missing_file_raises(tmp_path: Path):
    with pytest.raises(StoryParseError):
        load_story(tmp_path / "nope.txt")


def test_sample_story_parses(tmp_path: Path):
    story = load_story(Path(__file__).resolve().parent.parent / "input" / "story.txt",
                       keywords=KEYWORDS)
    assert len(story) == 5
    assert story.parts[0].slug == "part_001"
