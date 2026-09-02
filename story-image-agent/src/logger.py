"""Logging setup for the story image agent.

Everything the agent writes goes through here so that a single redaction filter
can strip anything that looks like a credential (cookies, bearer tokens, long
opaque ids) before it ever reaches the console or the log file.
"""

from __future__ import annotations

import logging
import re
import sys
from pathlib import Path
from typing import Any, Iterable

LOGGER_NAME = "story_image_agent"

_REDACTION_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?i)\b(cookie|set-cookie)\b\s*[:=]\s*\S+", re.UNICODE), r"\1=<redacted>"),
    (re.compile(r"(?i)\b(authorization|bearer|token|api[_-]?key|password|secret)\b\s*[:=]?\s*\S+"),
     r"\1=<redacted>"),
    (re.compile(r"(?i)\b(SID|HSID|SSID|APISID|SAPISID|SIDCC|__Secure-[A-Za-z0-9_-]+)\s*=\s*\S+"),
     r"\1=<redacted>"),
    (re.compile(r"\bya29\.[A-Za-z0-9._-]+"), "<redacted-oauth-token>"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+"), "<redacted-jwt>"),
)


class RedactingFilter(logging.Filter):
    """Scrubs credential-looking substrings from every log record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = self.redact(record.getMessage())
        record.args = ()
        return True

    @staticmethod
    def redact(text: str) -> str:
        for pattern, replacement in _REDACTION_PATTERNS:
            text = pattern.sub(replacement, text)
        return text


class _ConsoleFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        prefix = {
            logging.DEBUG: "  · ",
            logging.INFO: "",
            logging.WARNING: "[!] ",
            logging.ERROR: "[x] ",
            logging.CRITICAL: "[X] ",
        }.get(record.levelno, "")
        return f"{prefix}{record.getMessage()}"


def setup_logging(
    logs_dir: Path,
    file_name: str = "agent.log",
    level: str = "INFO",
    console_level: str = "INFO",
) -> logging.Logger:
    """Configures and returns the shared agent logger (idempotent)."""
    logs_dir.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        handler.close()

    redactor = RedactingFilter()

    file_handler = logging.FileHandler(logs_dir / file_name, encoding="utf-8")
    file_handler.setLevel(getattr(logging, level.upper(), logging.INFO))
    file_handler.setFormatter(
        logging.Formatter("%(asctime)s | %(levelname)-8s | %(name)s | %(message)s")
    )
    file_handler.addFilter(redactor)

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(getattr(logging, console_level.upper(), logging.INFO))
    console_handler.setFormatter(_ConsoleFormatter())
    console_handler.addFilter(redactor)

    logger.addHandler(file_handler)
    logger.addHandler(console_handler)
    return logger


def get_logger(suffix: str | None = None) -> logging.Logger:
    """Returns the shared logger, or a named child of it."""
    return logging.getLogger(LOGGER_NAME if not suffix else f"{LOGGER_NAME}.{suffix}")


def progress(current: int, total: int, message: str) -> None:
    """Prints the `[3/50] ...` progress line required by the CLI."""
    get_logger().info("[%d/%d] %s", current, total, message)


def redact_all(values: Iterable[Any]) -> list[str]:
    return [RedactingFilter.redact(str(value)) for value in values]
