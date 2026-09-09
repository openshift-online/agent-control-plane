"""Durable runner acceptance cursor checks."""

import json

import pytest

from ambient_runner.platform.message_cursor import MessageCursor, MessageCursorError


@pytest.fixture
def cursor_path(tmp_path, monkeypatch):
    path = tmp_path / ".acp-runtime" / "message-cursor.json"
    monkeypatch.setenv("WORKSPACE_PATH", str(tmp_path))
    monkeypatch.setenv("ACP_MESSAGE_CURSOR_FILE", str(path))
    monkeypatch.delenv("IS_RESUME", raising=False)
    return path


def test_cursor_is_opt_in(monkeypatch):
    monkeypatch.delenv("ACP_MESSAGE_CURSOR_FILE", raising=False)
    assert MessageCursor.from_env("session-a") is None


def test_cursor_records_acceptance_and_reopens_without_replay(cursor_path, monkeypatch):
    cursor = MessageCursor.from_env("session-a")
    assert cursor is not None
    assert cursor.last_seq == 0
    assert cursor.accept(4)
    assert json.loads(cursor_path.read_text()) == {
        "version": 1,
        "session_id": "session-a",
        "last_seq": 4,
    }
    monkeypatch.setenv("IS_RESUME", "true")
    resumed = MessageCursor.from_env("session-a")
    assert resumed is not None
    assert resumed.last_seq == 4
    assert not resumed.accept(4)
    assert not resumed.accept(3)
    assert resumed.accept(5)


def test_parallel_cursor_instances_recheck_acceptance_under_lock(cursor_path):
    first = MessageCursor.from_env("session-a")
    second = MessageCursor.from_env("session-a")
    assert first is not None and second is not None
    assert first.accept(1)
    assert not second.accept(1)
    assert second.last_seq == 1


def test_resume_missing_cursor_fails_closed(cursor_path, monkeypatch):
    monkeypatch.setenv("IS_RESUME", "true")
    with pytest.raises(MessageCursorError, match="cursor is missing"):
        MessageCursor.from_env("session-a")
    assert not cursor_path.exists()


@pytest.mark.parametrize(
    "payload",
    [
        "not-json",
        '{"version":1,"session_id":"another-session","last_seq":3}',
        '{"version":1,"session_id":"session-a","last_seq":-1}',
        '{"version":1,"session_id":"session-a","last_seq":true}',
        '{"version":2,"session_id":"session-a","last_seq":3}',
        '{"version":1,"session_id":"session-a","last_seq":3,"unexpected":1}',
    ],
)
def test_invalid_or_cross_session_cursor_fails_closed(cursor_path, payload):
    cursor_path.parent.mkdir()
    cursor_path.write_text(payload)
    with pytest.raises(MessageCursorError):
        MessageCursor.from_env("session-a")
    assert cursor_path.read_text() == payload


def test_failed_atomic_replace_keeps_previous_cursor(cursor_path, monkeypatch):
    cursor = MessageCursor.from_env("session-a")
    assert cursor is not None
    assert cursor.accept(2)

    def fail_replace(*_args):
        raise OSError("storage unavailable")

    monkeypatch.setattr(
        "ambient_runner.platform.message_cursor.os.replace", fail_replace
    )
    with pytest.raises(MessageCursorError, match="Execution stopped before dispatch"):
        cursor.accept(3)
    assert json.loads(cursor_path.read_text())["last_seq"] == 2
    assert sorted(p.name for p in cursor_path.parent.iterdir()) == [
        "message-cursor.json",
        "message-cursor.json.lock",
    ]


def test_cursor_cannot_point_outside_workspace(cursor_path, monkeypatch, tmp_path):
    monkeypatch.setenv(
        "ACP_MESSAGE_CURSOR_FILE", str(tmp_path.parent / "outside-cursor.json")
    )
    with pytest.raises(MessageCursorError, match="inside the session workspace"):
        MessageCursor.from_env("session-a")


def test_cursor_rejects_symlink(cursor_path, tmp_path):
    cursor_path.parent.mkdir()
    target = tmp_path / "other.json"
    target.write_text('{"version":1,"session_id":"session-a","last_seq":0}')
    cursor_path.symlink_to(target)
    with pytest.raises(MessageCursorError, match="inside the session workspace"):
        MessageCursor.from_env("session-a")
