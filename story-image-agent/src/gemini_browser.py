"""Browser layer: drives the Gemini web UI with Playwright.

Design rules this module follows:

* Nothing here touches credentials. Login is manual: the agent opens a visible
  Chrome window, waits for the user to sign in, and only then continues. There
  is no CAPTCHA handling, no password entry, no protection bypass — when a
  challenge appears the agent stops and asks the user to resolve it by hand.
* The session is kept in a local persistent browser profile so the user signs in
  once. Cookies and tokens are never read, printed or logged.
* Every UI hook comes from `config/selectors.json` as an ordered list of
  candidates, resolved at runtime by `_resolve()`. When Gemini's UI changes,
  the fix is a JSON edit, not a code change.
* Waiting is done with Playwright waits and real page state (the stop button
  disappearing, an image node appearing and settling), never a fixed sleep as
  the primary mechanism.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

from config import Config
from image_downloader import ImageDownloader, SavedImage
from logger import get_logger

log = get_logger("browser")


class BrowserError(RuntimeError):
    """Base class for browser-layer failures."""


class LoginRequiredError(BrowserError):
    """The user is not signed in and did not sign in within the wait window."""


class HumanCheckRequired(BrowserError):
    """A CAPTCHA or security challenge is on screen; only a human may solve it."""


class RateLimited(BrowserError):
    """Gemini says the usage limit was reached. The agent waits; it never bypasses."""


class GenerationError(BrowserError):
    """The prompt was sent but no image came back."""


@dataclass
class GenerationResult:
    image: SavedImage
    response_text: str
    duration_s: float


def _ci(pattern: str) -> re.Pattern[str]:
    return re.compile(re.escape(pattern), re.IGNORECASE)


class GeminiBrowser:
    """Owns the browser session and all interaction with the Gemini page."""

    def __init__(self, config: Config, downloader: ImageDownloader) -> None:
        self.config = config
        self.downloader = downloader
        self._playwright: Any = None
        self.context: Any = None
        self.page: Any = None

    # ------------------------------------------------------------------ setup
    async def start(self) -> None:
        from playwright.async_api import async_playwright

        profile_dir = self.config.path("browser_profile_dir")
        profile_dir.mkdir(parents=True, exist_ok=True)

        self._playwright = await async_playwright().start()
        launch_kwargs: dict[str, Any] = {
            "user_data_dir": str(profile_dir),
            "headless": bool(self.config.get("browser.headless", False)),
            "accept_downloads": True,
            "viewport": self.config.get("browser.viewport",
                                        {"width": 1440, "height": 900}),
            "locale": self.config.get("browser.locale", "en-US"),
            "slow_mo": int(self.config.get("browser.slow_mo_ms", 0)),
            "args": ["--disable-blink-features=AutomationControlled"],
        }

        executable_path = str(self.config.get("browser.executable_path", "") or "")
        if executable_path:
            launch_kwargs["executable_path"] = executable_path
            log.info("Using the browser binary configured in browser.executable_path.")

        channel = self.config.get("browser.channel", "chrome")
        try:
            self.context = await self._playwright.chromium.launch_persistent_context(
                **({"channel": channel} if not executable_path else {}), **launch_kwargs
            )
            log.info("Launched browser channel '%s'.", channel)
        except Exception as exc:  # noqa: BLE001 - channel may not be installed
            if not self.config.get("browser.fallback_to_chromium", True):
                raise
            log.warning("Could not launch '%s' (%s); falling back to bundled Chromium.",
                        channel, exc)
            self.context = await self._playwright.chromium.launch_persistent_context(
                **launch_kwargs
            )

        self.context.set_default_timeout(self.config.timeout("prompt_submit_ms", 30000))
        self.page = self.context.pages[0] if self.context.pages else await self.context.new_page()

    async def close(self) -> None:
        try:
            if self.context:
                await self.context.close()
        finally:
            if self._playwright:
                await self._playwright.stop()
            self.context = None
            self.page = None
            self._playwright = None

    async def __aenter__(self) -> "GeminiBrowser":
        await self.start()
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    # -------------------------------------------------------- locator plumbing
    def _locator_from_spec(self, spec: dict[str, Any], root: Any = None) -> Any:
        scope = root if root is not None else self.page
        kind = str(spec.get("kind", "css")).lower()
        if kind == "role":
            name = spec.get("name")
            return scope.get_by_role(
                spec.get("role", "button"),
                name=_ci(str(name)) if name else None,
            )
        if kind == "label":
            return scope.get_by_label(_ci(str(spec.get("value", ""))))
        if kind == "placeholder":
            return scope.get_by_placeholder(_ci(str(spec.get("value", ""))))
        if kind == "testid":
            return scope.get_by_test_id(str(spec.get("value", "")))
        if kind == "text":
            return scope.get_by_text(_ci(str(spec.get("value", ""))))
        return scope.locator(str(spec.get("value", "")))

    async def _resolve(self, key: str, root: Any = None, timeout_ms: int = 5000,
                       require_visible: bool = True, last: bool = False) -> Any | None:
        """Returns the first candidate locator for `key` that exists on the page."""
        specs = self.config.selector(key)
        if not specs:
            log.debug("No selectors configured for '%s'.", key)
            return None
        per_candidate = max(500, timeout_ms // max(1, len(specs)))
        for spec in specs:
            try:
                locator = self._locator_from_spec(spec, root)
                count = await locator.count()
                if not count:
                    continue
                candidate = locator.last if last else locator.first
                if require_visible:
                    await candidate.wait_for(state="visible", timeout=per_candidate)
                log.debug("Selector '%s' resolved via %s", key, spec)
                return candidate
            except Exception:  # noqa: BLE001 - try the next candidate
                continue
        return None

    async def _resolve_or_fail(self, key: str, root: Any = None,
                               timeout_ms: int = 10000, last: bool = False) -> Any:
        locator = await self._resolve(key, root=root, timeout_ms=timeout_ms, last=last)
        if locator is None:
            await self.save_diagnostics(f"selector-miss-{key}")
            raise BrowserError(
                f"Could not find UI element '{key}' on the Gemini page. "
                f"Edit config/selectors.json and add a working candidate "
                f"(run `python src/main.py --mode inspect` to see what resolves)."
            )
        return locator

    # ------------------------------------------------------------------- login
    async def open_gemini(self) -> None:
        url = str(self.config.get("browser.gemini_url", "https://gemini.google.com/app"))
        log.info("Opening %s", url)
        await self.page.goto(url, wait_until="domcontentloaded",
                             timeout=self.config.timeout("page_load_ms", 60000))

    async def is_logged_in(self) -> bool:
        return await self._resolve("logged_in_marker", timeout_ms=6000) is not None

    async def check_human_challenge(self) -> bool:
        return await self._resolve("captcha_marker", timeout_ms=2000,
                                   require_visible=False) is not None

    async def ensure_logged_in(self) -> None:
        """Waits — without ever automating the login — until the app is usable."""
        await self.open_gemini()

        if await self.is_logged_in():
            log.info("Existing Gemini session found; no sign-in needed.")
            return

        wait_ms = self.config.timeout("login_wait_ms", 600000)
        log.warning("=" * 68)
        log.warning("MANUAL SIGN-IN REQUIRED")
        log.warning("A Chrome window is open. Please sign in to your Google/Gemini")
        log.warning("account there yourself, then leave the chat screen open.")
        log.warning("The agent will continue automatically once it sees the chat box.")
        log.warning("Waiting up to %d minutes. Nothing is typed for you.", wait_ms // 60000)
        log.warning("=" * 68)

        deadline = asyncio.get_event_loop().time() + wait_ms / 1000
        warned_about_challenge = False
        while asyncio.get_event_loop().time() < deadline:
            if await self.is_logged_in():
                log.info("Sign-in detected. Continuing.")
                return
            if not warned_about_challenge and await self.check_human_challenge():
                warned_about_challenge = True
                log.warning("A security check is on screen. Please solve it manually; "
                            "the agent will not attempt it.")
            await asyncio.sleep(3)

        await self.save_diagnostics("login-timeout")
        raise LoginRequiredError(
            "Timed out waiting for manual sign-in. Run the agent again and sign in "
            "when the browser window opens."
        )

    # -------------------------------------------------------------- interaction
    async def start_new_chat(self) -> bool:
        """Starts a fresh conversation so parts do not contaminate each other."""
        button = await self._resolve("new_chat_button", timeout_ms=4000)
        if button is None:
            log.debug("New-chat control not found; reloading the app instead.")
            await self.open_gemini()
            return False
        try:
            await button.click()
            await self.page.wait_for_timeout(1000)
            return True
        except Exception as exc:  # noqa: BLE001
            log.debug("New-chat click failed (%s); reloading instead.", exc)
            await self.open_gemini()
            return False

    async def send_prompt(self, prompt: str) -> None:
        """Types the prompt into the composer and submits it."""
        box = await self._resolve_or_fail("prompt_input",
                                          timeout_ms=self.config.timeout("prompt_submit_ms"))
        await box.click()
        try:
            await box.fill(prompt)
        except Exception:  # noqa: BLE001 - contenteditable that rejects fill()
            log.debug("fill() rejected by the composer; typing line by line.")
            for offset, line in enumerate(prompt.split("\n")):
                if offset:
                    await self.page.keyboard.press("Shift+Enter")
                await self.page.keyboard.insert_text(line)

        send_button = await self._resolve("send_button", timeout_ms=6000)
        if send_button is not None:
            try:
                await send_button.click()
                log.debug("Prompt submitted with the send button.")
                return
            except Exception as exc:  # noqa: BLE001
                log.debug("Send button click failed (%s); pressing Enter.", exc)
        await self.page.keyboard.press("Enter")

    async def _latest_response(self) -> Any | None:
        return await self._resolve("response_container", timeout_ms=8000, last=True)

    async def _response_text(self) -> str:
        container = await self._latest_response()
        if container is None:
            return ""
        try:
            return (await container.inner_text())[:4000]
        except Exception:  # noqa: BLE001
            return ""

    async def _check_page_state(self, text: str) -> None:
        lowered = text.lower()
        for phrase in self.config.phrases("rate_limit_text"):
            if phrase in lowered:
                raise RateLimited(f"Gemini reported a usage limit: '{phrase}'.")
        for phrase in self.config.phrases("refusal_text"):
            if phrase in lowered:
                raise GenerationError(f"Gemini declined this prompt: '{phrase}'.")
        if await self.check_human_challenge():
            raise HumanCheckRequired(
                "A CAPTCHA / security check appeared. Solve it in the open browser "
                "window, then re-run the agent (completed parts are skipped)."
            )

    async def wait_for_image(self) -> Any:
        """Waits for generation to finish and returns the image element.

        Completion is judged from real page state: the stop button disappearing,
        an image node appearing inside the latest response, and that image's src
        staying unchanged for a settle window (Gemini swaps in a low-res preview
        before the final asset).
        """
        timeout_ms = self.config.timeout("generation_ms", 300000)
        poll_ms = int(self.config.get("timeouts.generation_poll_ms", 2000))
        settle_ms = int(self.config.get("timeouts.generation_settle_ms", 4000))

        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout_ms / 1000
        stable_src: str | None = None
        stable_since: float | None = None

        while loop.time() < deadline:
            await self._check_page_state(await self._response_text())

            container = await self._latest_response()
            image = await self._resolve("generated_image", root=container,
                                        timeout_ms=2000, last=True)
            if image is None:
                image = await self._resolve("generated_image", timeout_ms=2000, last=True)

            if image is not None:
                try:
                    src = await image.get_attribute("src") or ""
                except Exception:  # noqa: BLE001 - node replaced mid-read
                    src = ""
                still_generating = await self._resolve(
                    "stop_button", timeout_ms=1000) is not None
                if src and not still_generating:
                    if src == stable_src and stable_since is not None:
                        if (loop.time() - stable_since) * 1000 >= settle_ms:
                            log.debug("Image settled after %.1fs.",
                                      loop.time() - stable_since)
                            return image
                    else:
                        stable_src, stable_since = src, loop.time()
                else:
                    stable_src, stable_since = None, None

            await self.page.wait_for_timeout(poll_ms)

        await self.save_diagnostics("generation-timeout")
        raise GenerationError(
            f"No finished image appeared within {timeout_ms // 1000}s. "
            f"A screenshot and the page HTML were saved to the diagnostics folder."
        )

    async def download_image(self, image_element: Any, stem: str) -> SavedImage:
        container = await self._latest_response()
        button = await self._resolve("image_download_button", root=container,
                                     timeout_ms=4000)
        if button is None:
            more = await self._resolve("image_more_options_button", root=container,
                                       timeout_ms=3000)
            if more is not None:
                try:
                    await more.click()
                    button = await self._resolve("image_download_button", timeout_ms=4000)
                except Exception:  # noqa: BLE001
                    button = None
        return await self.downloader.capture(
            self.page, self.context, image_element, stem, download_button=button
        )

    async def generate_image(self, prompt: str, stem: str,
                             fresh_chat: bool = True) -> GenerationResult:
        """Full round trip for one part: new chat → prompt → wait → download."""
        started = asyncio.get_event_loop().time()
        if fresh_chat:
            await self.start_new_chat()
        await self.send_prompt(prompt)
        image_element = await self.wait_for_image()
        response_text = await self._response_text()
        saved = await self.download_image(image_element, stem)
        return GenerationResult(
            image=saved,
            response_text=response_text[:1000],
            duration_s=round(asyncio.get_event_loop().time() - started, 1),
        )

    # ------------------------------------------------------------- diagnostics
    async def save_diagnostics(self, label: str) -> Path | None:
        """Saves a screenshot + HTML snapshot for troubleshooting a UI change."""
        if self.page is None:
            return None
        directory = self.config.path("diagnostics_dir")
        directory.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        safe_label = re.sub(r"[^A-Za-z0-9._-]", "-", label)
        base = directory / f"{stamp}-{safe_label}"
        try:
            await self.page.screenshot(path=str(base.with_suffix(".png")), full_page=True)
            html = await self.page.content()
            base.with_suffix(".html").write_text(html, encoding="utf-8")
            log.warning("Diagnostics saved: %s.png / .html", base.name)
            return base
        except Exception as exc:  # noqa: BLE001
            log.debug("Could not save diagnostics: %s", exc)
            return None

    async def inspect(self) -> dict[str, Any]:
        """Reports which selector candidates actually resolve on the live page.

        This is how you adapt to a Gemini UI change: run `--mode inspect`, see
        which hooks are missing, and add a working candidate to selectors.json.
        """
        keys: Sequence[str] = [
            "logged_in_marker", "prompt_input", "send_button", "new_chat_button",
            "stop_button", "response_container", "response_complete_marker",
            "generated_image", "image_download_button", "image_more_options_button",
            "captcha_marker",
        ]
        report: dict[str, Any] = {}
        for key in keys:
            findings = []
            for spec in self.config.selector(key):
                try:
                    locator = self._locator_from_spec(spec)
                    count = await locator.count()
                    visible = bool(count) and await locator.first.is_visible()
                except Exception as exc:  # noqa: BLE001
                    findings.append({"spec": spec, "error": str(exc)[:120]})
                    continue
                findings.append({"spec": spec, "count": count, "visible": visible})
            report[key] = findings
        return report
