"""Session-bound execution cursor stored beside the retained workspace.

The API remains the message history. This file records which user request the
runner accepted so a restarted process can consume queued requests in order.
"""

import fcntl
import json
import os
import stat
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

_MAX_CURSOR_BYTES = 4096
_MAX_SEQUENCE = (1 << 63) - 1


class MessageCursorError(RuntimeError):
    """A cursor cannot be trusted or saved; message execution must stop."""


class MessageCursor:
    def __init__(self, path: Path, session_id: str, workspace: Path, *, resume: bool):
        self.path = path
        self.session_id = session_id
        self.workspace = workspace
        self.last_seq = 0
        if not session_id or session_id == "unknown":
            raise MessageCursorError("A message cursor requires a valid session ID.")
        try:
            self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with self._locked():
                if self.path.exists():
                    self.last_seq = self._read()
                elif resume:
                    raise MessageCursorError(
                        "Cannot resume: the message cursor is missing. Restore the "
                        "session workspace cursor or create a new session."
                    )
                else:
                    self._write(0)
        except OSError as exc:
            raise MessageCursorError(
                "Cannot open the message cursor. Check the session workspace storage."
            ) from exc

    @classmethod
    def from_env(cls, session_id: str) -> "MessageCursor | None":
        configured = os.getenv("ACP_MESSAGE_CURSOR_FILE", "").strip()
        if not configured:
            return None
        workspace = Path(os.getenv("WORKSPACE_PATH", "/workspace")).resolve()
        path = Path(configured)
        if not path.is_absolute():
            path = workspace / path
        if path.is_symlink() or not path.resolve().is_relative_to(workspace):
            raise MessageCursorError(
                "The message cursor must be inside the session workspace."
            )
        return cls(
            path.resolve(),
            session_id,
            workspace,
            resume=os.getenv("IS_RESUME", "").strip().lower() == "true",
        )

    @contextmanager
    def _locked(self) -> Iterator[None]:
        if self.path.is_symlink() or not self.path.resolve().is_relative_to(
            self.workspace
        ):
            raise MessageCursorError(
                "The message cursor must stay inside the session workspace."
            )
        lock_path = self.path.with_name(self.path.name + ".lock")
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise MessageCursorError(
                    "The message cursor lock is not a regular file."
                )
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def _read(self) -> int:
        fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise MessageCursorError("The message cursor is not a regular file.")
            with os.fdopen(fd, "rb", closefd=False) as source:
                raw = source.read(_MAX_CURSOR_BYTES + 1)
            data = json.loads(raw)
        except (ValueError, UnicodeError) as exc:
            raise MessageCursorError(
                "The message cursor is corrupt. Restore its last valid copy before resuming."
            ) from exc
        finally:
            os.close(fd)
        if (
            len(raw) > _MAX_CURSOR_BYTES
            or not isinstance(data, dict)
            or set(data) != {"version", "session_id", "last_seq"}
            or type(data["version"]) is not int
            or data["version"] != 1
            or data["session_id"] != self.session_id
            or type(data["last_seq"]) is not int
            or not 0 <= data["last_seq"] <= _MAX_SEQUENCE
        ):
            raise MessageCursorError(
                "The message cursor does not match this session or has invalid data. "
                "Restore the correct session workspace cursor before resuming."
            )
        return data["last_seq"]

    def _write(self, sequence: int) -> None:
        payload = json.dumps(
            {"version": 1, "session_id": self.session_id, "last_seq": sequence}
        )
        temporary: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self.path.parent, delete=False
            ) as output:
                temporary = output.name
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
            temporary = None
            directory = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if temporary is not None:
                os.unlink(temporary)

    def accept(self, sequence: int) -> bool:
        """Save acceptance before dispatch; return false for an accepted sequence."""
        if type(sequence) is not int or not 0 < sequence <= _MAX_SEQUENCE:
            raise MessageCursorError("The API message has an invalid sequence number.")
        try:
            with self._locked():
                # Read again under the lock so concurrent processes cannot accept
                # the same request from an old in-memory cursor.
                self.last_seq = self._read()
                if sequence <= self.last_seq:
                    return False
                self._write(sequence)
                self.last_seq = sequence
                return True
        except OSError as exc:
            raise MessageCursorError(
                "Cannot save the message cursor. Execution stopped before dispatch. "
                "Check the session workspace storage before resuming."
            ) from exc
