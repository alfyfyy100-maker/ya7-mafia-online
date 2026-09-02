"""Shared test fixtures."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

import pytest

from config import load_config

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def make_png(width: int = 160, height: int = 120) -> bytes:
    """Builds a valid PNG without any third-party dependency."""
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0
        for x in range(width):
            raw += bytes(((x * 2) % 256, (y * 2) % 256, ((x + y) * 3) % 256))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    header = struct.pack(">2I5B", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + chunk(b"IEND", b""))


@pytest.fixture
def png_bytes() -> bytes:
    return make_png()


@pytest.fixture
def config(tmp_path: Path):
    """A real config object with every output path redirected into tmp_path."""
    cfg = load_config()
    for key in ("output_dir", "images_dir", "prompts_dir", "metadata_dir",
                "logs_dir", "diagnostics_dir", "state_file", "failed_parts_file",
                "character_bible_file", "browser_profile_dir"):
        original = Path(str(cfg.get(f"paths.{key}")))
        cfg.data["paths"][key] = str(tmp_path / original)
    cfg.root = tmp_path
    cfg.data["paths"]["story_file"] = str(PROJECT_ROOT / "input" / "story.txt")
    cfg.ensure_directories()
    return cfg
