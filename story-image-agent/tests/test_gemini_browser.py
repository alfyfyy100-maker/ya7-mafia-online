"""End-to-end test of the browser layer against a local mock of the chat UI.

These tests never contact Google. They load `tests/mock_gemini.html`, which
mimics the DOM shapes that `config/selectors.json` targets, so a broken selector
file or a regression in the wait/download logic is caught locally.
"""

from __future__ import annotations

import asyncio
import base64
import os
from pathlib import Path

import pytest

from conftest import make_png
from gemini_browser import GeminiBrowser, GenerationError, RateLimited
from image_downloader import ImageDownloader

playwright_api = pytest.importorskip("playwright.async_api")

TEMPLATE = Path(__file__).resolve().parent / "mock_gemini.html"


def _mock_page(tmp_path: Path, mode: str = "image") -> Path:
    data_uri = "data:image/png;base64," + base64.b64encode(make_png()).decode()
    html = (TEMPLATE.read_text(encoding="utf-8")
            .replace("__IMAGE_DATA_URI__", data_uri)
            .replace("__MODE__", mode))
    path = tmp_path / f"mock_{mode}.html"
    path.write_text(html, encoding="utf-8")
    return path


def _chromium_binary() -> str:
    """Finds a Chromium the local Playwright build can drive, if any."""
    roots = [Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "")),
             Path.home() / ".cache" / "ms-playwright"]
    for root in roots:
        if not root or not root.exists():
            continue
        for candidate in sorted(root.glob("chromium*/chrome-linux/chrome")) + \
                sorted(root.glob("chromium*/chrome-linux64/chrome")) + \
                sorted(root.glob("chromium*/chrome-win/chrome.exe")):
            if candidate.exists():
                return str(candidate)
    return ""


def _prepare(config, tmp_path: Path, mode: str) -> GeminiBrowser:
    config.override("browser.headless", True)
    config.override("browser.channel", "chromium")
    binary = _chromium_binary()
    if binary:
        config.override("browser.executable_path", binary)
    config.override("browser.gemini_url", _mock_page(tmp_path, mode).as_uri())
    config.data["timeouts"].update({
        "generation_ms": 30000, "generation_poll_ms": 250,
        "generation_settle_ms": 700, "login_wait_ms": 5000,
    })
    downloader = ImageDownloader(config.path("images_dir"), min_bytes=500)
    return GeminiBrowser(config, downloader)


def _run(coro):
    return asyncio.run(coro)


@pytest.mark.slow
def test_full_round_trip_against_mock_ui(config, tmp_path: Path):
    browser = _prepare(config, tmp_path, "image")

    async def scenario():
        await browser.start()
        try:
            await browser.ensure_logged_in()
            assert await browser.is_logged_in()
            return await browser.generate_image("a test prompt\nsecond line",
                                                "part_001", fresh_chat=False)
        finally:
            await browser.close()

    result = _run(scenario())
    assert result.image.path.exists()
    assert result.image.path.name.startswith("part_001")
    assert result.image.size_bytes > 500
    assert result.duration_s >= 0


@pytest.mark.slow
def test_rate_limit_message_is_detected_and_not_bypassed(config, tmp_path: Path):
    browser = _prepare(config, tmp_path, "rate_limit")

    async def scenario():
        await browser.start()
        try:
            await browser.ensure_logged_in()
            await browser.send_prompt("prompt")
            await browser.wait_for_image()
        finally:
            await browser.close()

    with pytest.raises(RateLimited):
        _run(scenario())


@pytest.mark.slow
def test_refusal_is_reported_as_a_generation_error(config, tmp_path: Path):
    browser = _prepare(config, tmp_path, "refusal")

    async def scenario():
        await browser.start()
        try:
            await browser.ensure_logged_in()
            await browser.send_prompt("prompt")
            await browser.wait_for_image()
        finally:
            await browser.close()

    with pytest.raises(GenerationError):
        _run(scenario())


@pytest.mark.slow
def test_inspect_reports_resolved_selectors(config, tmp_path: Path):
    browser = _prepare(config, tmp_path, "image")

    async def scenario():
        await browser.start()
        try:
            await browser.ensure_logged_in()
            return await browser.inspect()
        finally:
            await browser.close()

    report = _run(scenario())
    assert any(entry.get("count") for entry in report["prompt_input"])
    assert any(entry.get("count") for entry in report["send_button"])
