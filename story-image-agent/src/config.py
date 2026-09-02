"""Configuration loading.

`config/config.json` holds every tunable knob (paths, timeouts, retry policy,
style bible). `config/selectors.json` holds every Gemini UI hook. Both are plain
JSON so the user can edit them without touching Python.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config" / "config.json"
DEFAULT_SELECTORS_PATH = PROJECT_ROOT / "config" / "selectors.json"


class ConfigError(RuntimeError):
    """Raised when the configuration file is missing or malformed."""


@dataclass
class Config:
    """Parsed configuration with convenience accessors for resolved paths."""

    data: dict[str, Any]
    selectors: dict[str, Any]
    root: Path = PROJECT_ROOT
    source_path: Path = DEFAULT_CONFIG_PATH
    _overrides: dict[str, Any] = field(default_factory=dict)

    # ---- generic access -------------------------------------------------
    def get(self, dotted_key: str, default: Any = None) -> Any:
        """Reads `section.key` style paths, honouring CLI overrides."""
        if dotted_key in self._overrides:
            return self._overrides[dotted_key]
        node: Any = self.data
        for part in dotted_key.split("."):
            if not isinstance(node, dict) or part not in node:
                return default
            node = node[part]
        return node

    def override(self, dotted_key: str, value: Any) -> None:
        self._overrides[dotted_key] = value

    # ---- paths ----------------------------------------------------------
    def path(self, key: str) -> Path:
        raw = self.get(f"paths.{key}")
        if raw is None:
            raise ConfigError(f"Missing path config: paths.{key}")
        candidate = Path(raw)
        return candidate if candidate.is_absolute() else (self.root / candidate)

    def ensure_directories(self) -> None:
        for key in (
            "output_dir",
            "images_dir",
            "prompts_dir",
            "metadata_dir",
            "logs_dir",
            "diagnostics_dir",
        ):
            self.path(key).mkdir(parents=True, exist_ok=True)

    # ---- shortcuts ------------------------------------------------------
    @property
    def style_bible(self) -> dict[str, Any]:
        return dict(self.get("style_bible", {}))

    @property
    def max_retries(self) -> int:
        return int(self.get("retry.max_retries", 3))

    def timeout(self, key: str, default: int = 30000) -> int:
        return int(self.get(f"timeouts.{key}", default))

    def selector(self, key: str) -> list[dict[str, Any]]:
        value = self.selectors.get(key, [])
        return [entry for entry in value if isinstance(entry, dict)]

    def phrases(self, key: str) -> list[str]:
        value = self.selectors.get(key, [])
        return [str(entry).lower() for entry in value if isinstance(entry, str)]


def load_config(
    config_path: Path | str | None = None,
    selectors_path: Path | str | None = None,
) -> Config:
    """Loads config + selectors from disk, raising a clear error on failure."""
    cfg_path = Path(config_path) if config_path else DEFAULT_CONFIG_PATH
    sel_path = Path(selectors_path) if selectors_path else DEFAULT_SELECTORS_PATH

    if not cfg_path.exists():
        raise ConfigError(f"Config file not found: {cfg_path}")

    try:
        data = json.loads(cfg_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(f"Invalid JSON in {cfg_path}: {exc}") from exc

    selectors: dict[str, Any] = {}
    if sel_path.exists():
        try:
            selectors = json.loads(sel_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ConfigError(f"Invalid JSON in {sel_path}: {exc}") from exc

    root = cfg_path.resolve().parent.parent
    return Config(data=data, selectors=selectors, root=root, source_path=cfg_path)
