"""Image acquisition and validation.

Getting the generated image off the page is the least stable part of any browser
automation, so four independent strategies are tried in order:

  1. the page's own download control (`expect_download` → `save_as`),
  2. an authenticated context request for the image URL,
  3. in-page fetch of `blob:` / `data:` sources, returned as base64,
  4. an element screenshot of the image node, as a last resort.

Whatever arrives is validated by magic bytes and minimum size before it is
accepted, so a truncated or HTML-error body is never saved as an image.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from logger import get_logger

log = get_logger("images")

_MAGIC = {
    b"\x89PNG\r\n\x1a\n": "png",
    b"\xff\xd8\xff": "jpg",
    b"GIF87a": "gif",
    b"GIF89a": "gif",
    b"RIFF": "webp",
}


class ImageError(RuntimeError):
    """Raised when no strategy produced a valid image."""


@dataclass
class SavedImage:
    path: Path
    size_bytes: int
    image_format: str
    strategy: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": str(self.path),
            "size_bytes": self.size_bytes,
            "format": self.image_format,
            "strategy": self.strategy,
        }


def detect_format(data: bytes) -> str | None:
    for magic, name in _MAGIC.items():
        if data.startswith(magic):
            if name == "webp" and data[8:12] != b"WEBP":
                continue
            return name
    return None


def validate_image_bytes(data: bytes, min_bytes: int) -> str:
    """Returns the detected format, or raises ImageError."""
    if not data:
        raise ImageError("empty image payload")
    if len(data) < min_bytes:
        raise ImageError(f"image too small ({len(data)} bytes < {min_bytes})")
    image_format = detect_format(data)
    if not image_format:
        head = data[:16].hex()
        raise ImageError(f"payload is not a recognised image (starts with {head})")
    return image_format


def _to_png(data: bytes, image_format: str) -> tuple[bytes, str]:
    """Converts to PNG when Pillow is available; otherwise keeps the original."""
    if image_format == "png":
        return data, "png"
    try:
        import io

        from PIL import Image  # type: ignore[import-not-found]
    except ImportError:
        log.debug("Pillow not installed; keeping the original %s file.", image_format)
        return data, image_format
    buffer = io.BytesIO()
    with Image.open(io.BytesIO(data)) as image:
        image.convert("RGBA" if image.mode in ("RGBA", "LA", "P") else "RGB").save(
            buffer, format="PNG"
        )
    return buffer.getvalue(), "png"


class ImageDownloader:
    """Saves the generated image for one part."""

    def __init__(self, images_dir: Path, min_bytes: int = 8000,
                 preferred_format: str = "png", download_timeout_ms: int = 120000) -> None:
        self.images_dir = images_dir
        self.min_bytes = min_bytes
        self.preferred_format = preferred_format.lower()
        self.download_timeout_ms = download_timeout_ms

    def target_path(self, stem: str, extension: str) -> Path:
        return self.images_dir / f"{stem}.{extension}"

    def save_bytes(self, data: bytes, stem: str, strategy: str) -> SavedImage:
        image_format = validate_image_bytes(data, self.min_bytes)
        if self.preferred_format == "png":
            data, image_format = _to_png(data, image_format)
        self.images_dir.mkdir(parents=True, exist_ok=True)
        path = self.target_path(stem, image_format)
        path.write_bytes(data)
        log.info("Saved %s (%s, %.1f KB, via %s)", path.name, image_format,
                 len(data) / 1024, strategy)
        return SavedImage(path=path, size_bytes=len(data), image_format=image_format,
                          strategy=strategy)

    # -- acquisition strategies -------------------------------------------
    async def from_download_button(self, page: Any, button: Any, stem: str) -> SavedImage:
        """Strategy 1 — use the page's own download control."""
        async with page.expect_download(timeout=self.download_timeout_ms) as download_info:
            await button.click()
        download = await download_info.value
        temp_path = Path(await download.path()) if await download.path() else None
        if temp_path is None:
            raise ImageError("browser reported a download with no file on disk")
        data = temp_path.read_bytes()
        return self.save_bytes(data, stem, "download-button")

    async def from_url(self, context: Any, url: str, stem: str) -> SavedImage:
        """Strategy 2 — refetch the image URL through the logged-in context."""
        response = await context.request.get(url, timeout=self.download_timeout_ms)
        if not response.ok:
            raise ImageError(f"image request failed with HTTP {response.status}")
        data = await response.body()
        return self.save_bytes(data, stem, "context-request")

    async def from_page_fetch(self, page: Any, url: str, stem: str) -> SavedImage:
        """Strategy 3 — read `blob:`/`data:` sources from inside the page."""
        if url.startswith("data:"):
            _, _, payload = url.partition(",")
            data = base64.b64decode(payload)
            return self.save_bytes(data, stem, "data-uri")

        encoded: str = await page.evaluate(
            """async (src) => {
                const response = await fetch(src);
                const buffer = await response.arrayBuffer();
                let binary = '';
                const bytes = new Uint8Array(buffer);
                const chunk = 0x8000;
                for (let i = 0; i < bytes.length; i += chunk) {
                    binary += String.fromCharCode.apply(
                        null, bytes.subarray(i, i + chunk));
                }
                return btoa(binary);
            }""",
            url,
        )
        return self.save_bytes(base64.b64decode(encoded), stem, "page-fetch")

    async def from_element_screenshot(self, element: Any, stem: str) -> SavedImage:
        """Strategy 4 — screenshot the image element itself."""
        data = await element.screenshot(type="png")
        return self.save_bytes(data, stem, "element-screenshot")

    async def capture(self, page: Any, context: Any, image_element: Any, stem: str,
                      download_button: Any | None = None) -> SavedImage:
        """Runs every strategy in order and returns the first valid image."""
        errors: list[str] = []

        if download_button is not None:
            try:
                return await self.from_download_button(page, download_button, stem)
            except Exception as exc:  # noqa: BLE001 - fall through to the next strategy
                errors.append(f"download-button: {exc}")
                log.debug("Download button strategy failed: %s", exc)

        src = ""
        if image_element is not None:
            try:
                src = await image_element.get_attribute("src") or ""
            except Exception as exc:  # noqa: BLE001
                errors.append(f"read-src: {exc}")

        if src.startswith("http"):
            try:
                return await self.from_url(context, src, stem)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"context-request: {exc}")
                log.debug("Context request strategy failed: %s", exc)

        if src:
            try:
                return await self.from_page_fetch(page, src, stem)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"page-fetch: {exc}")
                log.debug("Page fetch strategy failed: %s", exc)

        if image_element is not None:
            try:
                return await self.from_element_screenshot(image_element, stem)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"element-screenshot: {exc}")

        raise ImageError("could not download the generated image — " + "; ".join(errors))
