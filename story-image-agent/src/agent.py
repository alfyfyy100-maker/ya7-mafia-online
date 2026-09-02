"""Pipeline orchestration: story → bible → prompts → images.

`StoryImageAgent` wires the modules together and owns the run loop: progress
lines, retries with backoff, checkpointing after every part, metadata writing,
and the safe stops (CAPTCHA, rate limit) required by the brief.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from character_manager import CharacterBible
from checkpoint_manager import CheckpointManager
from config import Config
from gemini_browser import (
    BrowserError,
    GeminiBrowser,
    GenerationResult,
    HumanCheckRequired,
    RateLimited,
)
from image_downloader import ImageDownloader
from logger import get_logger, progress
from prompt_generator import PromptGenerator
from story_parser import Part, Story, load_story

log = get_logger("agent")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class RunOutcome:
    requested: int = 0
    generated: int = 0
    skipped: int = 0
    failed: int = 0
    stopped_early: str = ""

    def format(self) -> str:
        lines = [
            "Run summary",
            "-----------",
            f"  requested : {self.requested}",
            f"  generated : {self.generated}",
            f"  skipped   : {self.skipped} (already complete)",
            f"  failed    : {self.failed}",
        ]
        if self.stopped_early:
            lines.append(f"  stopped   : {self.stopped_early}")
        return "\n".join(lines)


class StoryImageAgent:
    """The whole pipeline, in one object."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.config.ensure_directories()
        self.story: Story | None = None
        self.bible = CharacterBible(self.config.path("character_bible_file"))
        self.checkpoint = CheckpointManager(
            self.config.path("state_file"), self.config.path("failed_parts_file")
        ).load()
        self.downloader = ImageDownloader(
            images_dir=self.config.path("images_dir"),
            min_bytes=int(self.config.get("image.min_bytes", 8000)),
            preferred_format=str(self.config.get("image.format", "png")),
            download_timeout_ms=self.config.timeout("download_ms", 120000),
        )
        self.prompts: PromptGenerator | None = None

    # --------------------------------------------------------------- loading
    def load(self, rebuild_bible: bool = False) -> Story:
        """Parses the story and builds/loads the character bible."""
        story_path = self.config.path("story_file")
        self.story = load_story(
            story_path,
            keywords=self.config.get("story.part_keywords"),
            fallback_chunk_paragraphs=int(self.config.get("story.fallback_chunk_paragraphs", 3)),
            min_part_chars=int(self.config.get("story.min_part_chars", 20)),
        )
        self.checkpoint.bind_story(
            story_path.read_text(encoding="utf-8-sig"), len(self.story)
        )

        self.bible.load()
        self.bible.build_from_story(self.story, overwrite=rebuild_bible)
        self.bible.save()

        self.prompts = PromptGenerator(
            bible=self.bible,
            style=self.config.style_bible,
            prompts_dir=self.config.path("prompts_dir"),
            max_excerpt_chars=int(self.config.get("prompt.max_scene_summary_chars", 700)),
            include_negative=bool(self.config.get("prompt.include_negative_section", True)),
            max_characters=int(self.config.get("prompt.max_characters_per_prompt", 4)),
        )
        return self.story

    def _require_story(self) -> Story:
        if self.story is None:
            self.load()
        assert self.story is not None
        return self.story

    # -------------------------------------------------------------- analysis
    def analyze(self) -> str:
        """Mode 1: parse the story, build the bible, report what was found."""
        story = self._require_story()
        lines = [
            "Story analysis",
            "--------------",
            f"  file      : {story.source_path}",
            f"  detection : {story.detection}",
            f"  parts     : {len(story)}",
            f"  words     : {sum(p.word_count for p in story.parts)}",
            "",
            f"Character bible ({len(self.bible)} entries) → {self.bible.path}",
        ]
        for character in self.bible.characters.values():
            appears = ", ".join(str(i) for i in character.appears_in[:12]) or "—"
            lines.append(f"  • {character.display_name or character.name} "
                         f"[{character.gender}, {character.age}] parts: {appears}")
            lines.append(f"      {character.visual_description()}")
        lines += ["", "First parts:"]
        for part in story.parts[:5]:
            preview = " ".join(part.text.split())[:90]
            lines.append(f"  {part.index:03d}. {part.label or part.slug} — {preview}…")
        return "\n".join(lines)

    # --------------------------------------------------------------- prompts
    def generate_prompts(self, indices: Sequence[int] | None = None) -> list[Path]:
        """Mode 2: write one prompt file per part (no browser involved)."""
        story = self._require_story()
        assert self.prompts is not None
        targets = [p for p in story.parts if indices is None or p.index in indices]
        written: list[Path] = []
        for position, part in enumerate(targets, start=1):
            prompt, analysis, characters = self.prompts.generate_and_save(part)
            self._write_metadata(part, prompt, analysis, characters, status="prompt-ready")
            written.append(self.prompts.prompt_path(part))
            progress(position, len(targets), f"Prompt written for {part.slug}")
        return written

    # -------------------------------------------------------------- metadata
    def _metadata_path(self, part: Part) -> Path:
        return self.config.path("metadata_dir") / f"{part.slug}.json"

    def _write_metadata(self, part: Part, prompt: str, analysis: Any,
                        characters: Sequence[Any], status: str,
                        result: GenerationResult | None = None,
                        error: str = "", attempts: int = 0) -> Path:
        path = self._metadata_path(part)
        existing: dict[str, Any] = {}
        if path.exists():
            try:
                existing = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                existing = {}

        payload: dict[str, Any] = {
            **existing,
            "part_index": part.index,
            "slug": part.slug,
            "label": part.label,
            "title": part.title,
            "source_number": part.source_number,
            "word_count": part.word_count,
            "status": status,
            "updated_at": _now(),
            "prompt_file": str(self.config.path("prompts_dir") / f"{part.slug}.txt"),
            "prompt": prompt,
            "scene_analysis": analysis.to_dict() if hasattr(analysis, "to_dict") else {},
            "characters": [
                {"name": c.name, "description": c.visual_description()} for c in characters
            ],
            "style_bible": self.config.style_bible,
        }
        if attempts:
            payload["attempts"] = attempts
        if error:
            payload["last_error"] = error
        if result is not None:
            payload["image"] = result.image.to_dict()
            payload["generation_seconds"] = result.duration_s
            payload["model_response_excerpt"] = result.response_text
            payload["error"] = ""

        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return path

    # ------------------------------------------------------------------- run
    async def run(self, indices: Sequence[int] | None = None, limit: int | None = None,
                  start_at: int | None = None, only_failed: bool = False,
                  force: bool = False, fresh_chat: bool = True) -> RunOutcome:
        """Modes 3/4/5: drive the browser and generate images for the selected parts."""
        story = self._require_story()
        assert self.prompts is not None

        selected = self._select_parts(story, indices, limit, start_at, only_failed, force)
        outcome = RunOutcome(requested=len(selected))
        if not selected:
            log.info("Nothing to do — every requested part is already complete.")
            return outcome

        log.info("Starting run for %d part(s): %s", len(selected),
                 ", ".join(str(p.index) for p in selected[:20]))

        max_retries = self.config.max_retries
        backoff_base = float(self.config.get("retry.initial_backoff_s", 5))
        backoff_mult = float(self.config.get("retry.backoff_multiplier", 2.0))
        backoff_cap = float(self.config.get("retry.max_backoff_s", 120))
        between_parts = float(self.config.get("pacing.delay_between_parts_s", 8))

        browser = GeminiBrowser(self.config, self.downloader)
        try:
            await browser.start()
            await browser.ensure_logged_in()

            for position, part in enumerate(selected, start=1):
                progress(position, len(selected),
                         f"Generating {part.slug} ({part.label or 'part'})…")
                prompt, analysis, characters = self.prompts.generate_and_save(part)

                last_error = ""
                for attempt in range(1, max_retries + 1):
                    try:
                        result = await browser.generate_image(
                            prompt, part.slug, fresh_chat=fresh_chat
                        )
                    except HumanCheckRequired as exc:
                        outcome.stopped_early = str(exc)
                        self._write_metadata(part, prompt, analysis, characters,
                                             status="blocked", error=str(exc),
                                             attempts=attempt)
                        self.checkpoint.mark_failed(part.index, str(exc), attempt)
                        outcome.failed += 1
                        log.error("%s", exc)
                        return outcome
                    except RateLimited as exc:
                        last_error = str(exc)
                        policy = str(self.config.get("pacing.on_rate_limit", "pause"))
                        log.warning("%s (policy: %s)", exc, policy)
                        if policy == "stop":
                            outcome.stopped_early = "usage limit reached"
                            self.checkpoint.mark_failed(part.index, last_error, attempt)
                            outcome.failed += 1
                            return outcome
                        cooldown = float(self.config.get("pacing.rate_limit_cooldown_s", 900))
                        log.warning("Waiting %.0f minutes before trying again. "
                                    "The agent does not attempt to bypass the limit.",
                                    cooldown / 60)
                        await asyncio.sleep(cooldown)
                        continue
                    except (BrowserError, Exception) as exc:  # noqa: BLE001
                        last_error = f"{type(exc).__name__}: {exc}"
                        log.warning("Attempt %d/%d for %s failed: %s",
                                    attempt, max_retries, part.slug, last_error)
                        await browser.save_diagnostics(f"{part.slug}-attempt{attempt}")
                        if attempt < max_retries:
                            delay = min(backoff_cap, backoff_base * (backoff_mult ** (attempt - 1)))
                            log.info("Retrying in %.0fs…", delay)
                            await asyncio.sleep(delay)
                        continue

                    self._write_metadata(part, prompt, analysis, characters,
                                         status="done", result=result, attempts=attempt)
                    self.checkpoint.mark_completed(part.index)
                    outcome.generated += 1
                    log.info("%s done in %.1fs → %s", part.slug, result.duration_s,
                             result.image.path.name)
                    break
                else:
                    self._write_metadata(part, prompt, analysis, characters,
                                         status="failed", error=last_error,
                                         attempts=max_retries)
                    self.checkpoint.mark_failed(part.index, last_error, max_retries)
                    outcome.failed += 1
                    log.error("%s failed after %d attempts; moving on. Last error: %s",
                              part.slug, max_retries, last_error)

                if position < len(selected) and between_parts > 0:
                    await asyncio.sleep(between_parts)
        finally:
            await browser.close()

        return outcome

    def _select_parts(self, story: Story, indices: Sequence[int] | None,
                      limit: int | None, start_at: int | None, only_failed: bool,
                      force: bool) -> list[Part]:
        if only_failed:
            wanted = set(self.checkpoint.failed_indices()) | {
                p.index for p in story.parts if not self.checkpoint.is_completed(p.index)
            }
            parts = [p for p in story.parts if p.index in wanted]
        elif indices:
            parts = [p for p in story.parts if p.index in set(indices)]
        else:
            parts = list(story.parts)

        if start_at:
            parts = [p for p in parts if p.index >= start_at]
        if not force:
            parts = [p for p in parts if not self.checkpoint.is_completed(p.index)]
        if limit:
            parts = parts[:limit]
        return parts

    # -------------------------------------------------------------- reporting
    def progress_report(self) -> str:
        story = self._require_story()
        return self.checkpoint.format_summary([p.index for p in story.parts])

    async def inspect_ui(self, probe: bool = False) -> str:
        """Opens Gemini and reports which selector candidates resolve right now.

        With `probe=True` the agent also sends one real prompt, so the hooks that
        only exist once an answer is on screen can be checked too.
        """
        probe_prompt = None
        if probe:
            probe_prompt = (
                "Create one simple illustrated image: a single closed wooden door "
                "in an empty room, warm side light, no text in the image."
            )

        browser = GeminiBrowser(self.config, self.downloader)
        try:
            await browser.start()
            await browser.ensure_logged_in()
            report = await browser.inspect(probe_prompt=probe_prompt)
        finally:
            await browser.close()

        out_path = self.config.path("diagnostics_dir") / "selector_report.json"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return self._format_selector_report(report, out_path)

    @staticmethod
    def _format_selector_report(report: dict[str, Any], out_path: Path) -> str:
        phases: dict[str, Any] = report.get("phases", {})
        expected: dict[str, str] = report.get("expected_phase", {})
        probe_ran = bool(report.get("probe_ran"))

        optional_keys = {"new_chat_button", "response_complete_marker",
                         "image_more_options_button", "loading_indicator"}

        lines = ["Selector report", "---------------"]
        for key, phase in expected.items():
            findings = None
            for candidate_phase in ("after_response", "generating",
                                    "composer_filled", "idle"):
                if key in phases.get(candidate_phase, {}):
                    findings = phases[candidate_phase][key]
                    if any(f.get("count") for f in findings):
                        break
            findings = findings or []
            hits = [f for f in findings if f.get("count")]

            if key == "captcha_marker":
                status, note = ("OK  ", "none on screen — no security check")
                if hits:
                    status, note = ("STOP", "a CAPTCHA / security check is showing; "
                                            "solve it manually in the browser")
            elif hits:
                status, note = "OK  ", hits[0]["spec"]
            elif phase in ("after_response", "generating") and not probe_ran:
                status, note = "n/a ", ("only exists while/after an answer is on screen "
                                        "— re-run with --probe to check it")
            elif key in optional_keys:
                status, note = "opt ", ("optional hook — the agent has a fallback "
                                        "and works without it")
            elif phase == "composer_filled" and "composer_filled" not in phases:
                status, note = "n/a ", "could not type into the composer to check"
            else:
                status, note = "MISS", "no candidate matched"
            lines.append(f"  [{status}] {key}: {note}")

        heuristic = report.get("heuristic_send_button")
        if heuristic:
            lines.append(f"\n  Heuristic send control found: {heuristic}")

        dump = report.get("dom_dump", {})
        if dump:
            buttons = [b for b in dump.get("buttons", []) if b.get("visible")]
            lines += [
                "",
                "Live DOM (what the page really contains):",
                f"  visible buttons  : {len(buttons)}",
                "  custom elements  : "
                + (", ".join(sorted(dump.get("custom_tags", {}))[:12]) or "—"),
                f"  images           : {len(dump.get('images', []))}",
            ]
            for button in buttons[:12]:
                label = button.get("aria_label") or button.get("title") \
                    or button.get("text") or button.get("icon") or "(no label)"
                lines.append(f"    · {button['tag']} — {label}")

        if not probe_ran:
            lines.append("\nTip: `--mode inspect --probe` sends one real prompt so the "
                         "answer-state hooks can be checked too.")
        lines.append(f"\nFull report (send this file if a hook is MISS): {out_path}")
        return "\n".join(lines)
