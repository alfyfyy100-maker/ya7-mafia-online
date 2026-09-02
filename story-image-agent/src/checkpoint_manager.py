"""Checkpoint / resume state.

`output/state.json` records which parts finished successfully; `output/failed_parts.json`
records the parts that exhausted their retries. Both are written after every part,
so killing the process mid-run never costs more than the part in flight — the next
run picks up at the first part that is not yet marked complete.
"""

from __future__ import annotations

import json
import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

from logger import get_logger

log = get_logger("checkpoint")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class FailedPart:
    index: int
    attempts: int
    error: str
    last_attempt: str = field(default_factory=_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "attempts": self.attempts,
            "error": self.error,
            "last_attempt": self.last_attempt,
        }


class CheckpointManager:
    """Durable progress tracking with atomic writes."""

    def __init__(self, state_path: Path, failed_path: Path) -> None:
        self.state_path = state_path
        self.failed_path = failed_path
        self.completed: set[int] = set()
        self.failed: dict[int, FailedPart] = {}
        self.story_hash: str = ""
        self.total_parts: int = 0
        self.started_at: str = _now()
        self.updated_at: str = _now()

    # -- persistence ------------------------------------------------------
    def load(self) -> "CheckpointManager":
        if self.state_path.exists():
            try:
                data = json.loads(self.state_path.read_text(encoding="utf-8"))
                self.completed = {int(i) for i in data.get("completed", [])}
                self.story_hash = data.get("story_hash", "")
                self.total_parts = int(data.get("total_parts", 0))
                self.started_at = data.get("started_at", self.started_at)
                self.updated_at = data.get("updated_at", self.updated_at)
                log.info("Checkpoint loaded: %d completed part(s).", len(self.completed))
            except (json.JSONDecodeError, ValueError) as exc:
                log.warning("Checkpoint file unreadable (%s); starting a fresh state.", exc)

        if self.failed_path.exists():
            try:
                entries = json.loads(self.failed_path.read_text(encoding="utf-8"))
                for entry in entries.get("failed_parts", []):
                    failed = FailedPart(
                        index=int(entry["index"]),
                        attempts=int(entry.get("attempts", 0)),
                        error=str(entry.get("error", "")),
                        last_attempt=entry.get("last_attempt", _now()),
                    )
                    self.failed[failed.index] = failed
            except (json.JSONDecodeError, KeyError, ValueError) as exc:
                log.warning("failed_parts.json unreadable (%s); starting empty.", exc)
        return self

    def save(self) -> None:
        self.updated_at = _now()
        self._atomic_write(self.state_path, {
            "story_hash": self.story_hash,
            "total_parts": self.total_parts,
            "completed": sorted(self.completed),
            "failed": sorted(self.failed),
            "started_at": self.started_at,
            "updated_at": self.updated_at,
        })
        self._atomic_write(self.failed_path, {
            "updated_at": self.updated_at,
            "failed_parts": [f.to_dict() for f in self.failed.values()],
        })

    @staticmethod
    def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(path.suffix + ".tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(path)

    # -- story binding ----------------------------------------------------
    @staticmethod
    def hash_story(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]

    def bind_story(self, story_text: str, total_parts: int, reset_on_change: bool = False) -> bool:
        """Binds state to a story; returns True when the story changed since last run."""
        new_hash = self.hash_story(story_text)
        changed = bool(self.story_hash) and self.story_hash != new_hash
        if changed:
            log.warning("Story file changed since the last run (parts may have shifted).")
            if reset_on_change:
                log.warning("Resetting checkpoint because --reset-on-change was set.")
                self.reset()
        self.story_hash = new_hash
        self.total_parts = total_parts
        return changed

    # -- progress ---------------------------------------------------------
    def is_completed(self, index: int) -> bool:
        return index in self.completed

    def mark_completed(self, index: int) -> None:
        self.completed.add(index)
        self.failed.pop(index, None)
        self.save()

    def mark_failed(self, index: int, error: str, attempts: int) -> None:
        self.failed[index] = FailedPart(index=index, attempts=attempts, error=error)
        self.save()

    def reset(self) -> None:
        self.completed.clear()
        self.failed.clear()
        self.save()

    def pending(self, indices: Sequence[int]) -> list[int]:
        return [i for i in indices if i not in self.completed]

    def failed_indices(self) -> list[int]:
        return sorted(self.failed)

    def next_index(self, indices: Sequence[int]) -> int | None:
        pending = self.pending(indices)
        return pending[0] if pending else None

    # -- reporting --------------------------------------------------------
    def summary(self, all_indices: Iterable[int] | None = None) -> dict[str, Any]:
        indices = sorted(all_indices) if all_indices is not None else []
        pending = self.pending(indices) if indices else []
        return {
            "total_parts": self.total_parts or len(indices),
            "completed": len(self.completed),
            "failed": len(self.failed),
            "pending": len(pending),
            "next_part": pending[0] if pending else None,
            "updated_at": self.updated_at,
        }

    def format_summary(self, all_indices: Iterable[int] | None = None) -> str:
        data = self.summary(all_indices)
        lines = [
            "Progress",
            "--------",
            f"  total parts : {data['total_parts']}",
            f"  completed   : {data['completed']}",
            f"  failed      : {data['failed']}",
            f"  pending     : {data['pending']}",
            f"  next part   : {data['next_part'] if data['next_part'] else '— nothing pending —'}",
            f"  updated     : {data['updated_at']}",
        ]
        if self.failed:
            lines.append("  failed parts:")
            for failed in sorted(self.failed.values(), key=lambda f: f.index):
                lines.append(f"    - part {failed.index:03d} "
                             f"({failed.attempts} attempt(s)): {failed.error[:120]}")
        return "\n".join(lines)
