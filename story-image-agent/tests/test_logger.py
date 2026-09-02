import logging
from pathlib import Path

from logger import RedactingFilter, setup_logging


def test_credentials_are_redacted():
    redact = RedactingFilter.redact
    assert "secret-cookie" not in redact("Cookie: secret-cookie-value")
    assert "ya29." not in redact("token ya29.abcdefghijklmnop")
    assert "<redacted" in redact("Authorization: Bearer abcdef123456")
    assert "<redacted" in redact("SAPISID=abc123def456")


def test_normal_messages_are_untouched():
    assert RedactingFilter.redact("Generating part_003") == "Generating part_003"


def test_log_file_never_contains_a_cookie(tmp_path: Path):
    log = setup_logging(tmp_path, file_name="test.log")
    log.info("Session restored with Cookie: __Secure-1PSID=super-secret-value")
    for handler in log.handlers:
        handler.flush()
    contents = (tmp_path / "test.log").read_text(encoding="utf-8")
    assert "super-secret-value" not in contents
    assert "<redacted>" in contents
    logging.getLogger("story_image_agent").handlers.clear()
