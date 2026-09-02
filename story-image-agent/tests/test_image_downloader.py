import base64
from pathlib import Path

import pytest

from image_downloader import ImageDownloader, ImageError, detect_format, validate_image_bytes


def test_detects_common_formats(png_bytes: bytes):
    assert detect_format(png_bytes) == "png"
    assert detect_format(b"\xff\xd8\xff\xe0rest") == "jpg"
    assert detect_format(b"not an image") is None


def test_validate_rejects_small_or_invalid_payloads(png_bytes: bytes):
    with pytest.raises(ImageError):
        validate_image_bytes(b"", 100)
    with pytest.raises(ImageError):
        validate_image_bytes(png_bytes, len(png_bytes) + 1)
    with pytest.raises(ImageError):
        validate_image_bytes(b"<html>error page</html>" * 100, 10)
    assert validate_image_bytes(png_bytes, 10) == "png"


def test_save_bytes_writes_named_file(tmp_path: Path, png_bytes: bytes):
    downloader = ImageDownloader(tmp_path, min_bytes=10)
    saved = downloader.save_bytes(png_bytes, "part_007", "unit-test")
    assert saved.path == tmp_path / "part_007.png"
    assert saved.path.read_bytes() == png_bytes
    assert saved.size_bytes == len(png_bytes)


def test_capture_falls_back_to_data_uri(tmp_path: Path, png_bytes: bytes):
    import asyncio

    class FakeElement:
        async def get_attribute(self, _name: str) -> str:
            return "data:image/png;base64," + base64.b64encode(png_bytes).decode()

    downloader = ImageDownloader(tmp_path, min_bytes=10)
    saved = asyncio.run(downloader.capture(page=None, context=None,
                                           image_element=FakeElement(), stem="part_001"))
    assert saved.strategy == "data-uri"
    assert (tmp_path / "part_001.png").exists()


def test_capture_raises_when_every_strategy_fails(tmp_path: Path):
    import asyncio

    class BrokenElement:
        async def get_attribute(self, _name: str) -> str:
            return ""

        async def screenshot(self, **_kwargs: object) -> bytes:
            raise RuntimeError("element gone")

    downloader = ImageDownloader(tmp_path, min_bytes=10)
    with pytest.raises(ImageError):
        asyncio.run(downloader.capture(page=None, context=None,
                                       image_element=BrokenElement(), stem="part_002"))
