from pathlib import Path

from checkpoint_manager import CheckpointManager


def _manager(tmp_path: Path) -> CheckpointManager:
    return CheckpointManager(tmp_path / "state.json", tmp_path / "failed.json").load()


def test_completed_parts_survive_a_restart(tmp_path: Path):
    manager = _manager(tmp_path)
    manager.bind_story("story text", total_parts=5)
    for index in (1, 2, 3, 4):
        manager.mark_completed(index)

    resumed = _manager(tmp_path)
    assert resumed.completed == {1, 2, 3, 4}
    assert resumed.next_index([1, 2, 3, 4, 5]) == 5
    assert resumed.pending([1, 2, 3, 4, 5]) == [5]


def test_failed_parts_are_recorded_and_cleared_on_success(tmp_path: Path):
    manager = _manager(tmp_path)
    manager.mark_failed(3, "timeout waiting for image", attempts=3)
    assert _manager(tmp_path).failed_indices() == [3]

    manager.mark_completed(3)
    reloaded = _manager(tmp_path)
    assert reloaded.failed_indices() == []
    assert reloaded.is_completed(3)


def test_story_change_is_detected(tmp_path: Path):
    manager = _manager(tmp_path)
    manager.bind_story("first version", total_parts=2)
    manager.mark_completed(1)

    reloaded = _manager(tmp_path)
    assert reloaded.bind_story("second version", total_parts=2) is True


def test_reset_clears_everything(tmp_path: Path):
    manager = _manager(tmp_path)
    manager.mark_completed(1)
    manager.mark_failed(2, "boom", 1)
    manager.reset()
    assert _manager(tmp_path).summary([1, 2])["completed"] == 0


def test_corrupt_state_file_does_not_crash(tmp_path: Path):
    (tmp_path / "state.json").write_text("{not json", encoding="utf-8")
    manager = _manager(tmp_path)
    assert manager.completed == set()


def test_summary_reports_progress(tmp_path: Path):
    manager = _manager(tmp_path)
    manager.bind_story("text", total_parts=3)
    manager.mark_completed(1)
    manager.mark_failed(2, "network", 3)
    summary = manager.summary([1, 2, 3])
    assert summary == {
        "total_parts": 3, "completed": 1, "failed": 1, "pending": 2,
        "next_part": 2, "updated_at": summary["updated_at"],
    }
    assert "failed parts" in manager.format_summary([1, 2, 3])
