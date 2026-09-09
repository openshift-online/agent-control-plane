"""Start one runner for each persisted session generation."""

import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path("/sandbox/workspace/.acp-runtime")


def write_state(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def main():
    action, generation = sys.argv[1:3]
    if not re.fullmatch(r"[a-zA-Z0-9-]{16,80}", generation):
        raise ValueError("invalid runner generation")
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    result = ROOT / (generation + ".json")
    current = ROOT / "current.json"
    if action == "worker":
        lock_fd = int(os.environ.pop("ACP_RUNTIME_LOCK_FD"))
        write_state(current, {"generation": generation, "state": "running"})
        try:
            process = subprocess.Popen(sys.argv[3:], pass_fds=(lock_fd,))
            code = process.wait()
        except Exception:
            code = 127
        write_state(result, {"generation": generation, "state": "exited", "exit_code": code})
        os.close(lock_fd)
        return
    lock_fd = os.open(ROOT / "runner.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock_fd)
        state = json.loads(current.read_text()) if current.exists() else {"generation": generation, "state": "running"}
        if state["generation"] != generation:
            state = {"state": "conflict"}
        print(json.dumps(state))
        return
    if result.exists():
        print(result.read_text())
    elif action == "status":
        print(json.dumps({"state": "missing"}))
    elif action == "start":
        write_state(current, {"generation": generation, "state": "running"})
        environment = dict(os.environ, ACP_RUNTIME_LOCK_FD=str(lock_fd))
        with (ROOT / (generation + ".log")).open("ab") as output:
            subprocess.Popen(
                [sys.executable, __file__, "worker", generation, *sys.argv[3:]],
                env=environment, pass_fds=(lock_fd,), start_new_session=True,
                stdin=subprocess.DEVNULL, stdout=output, stderr=output,
            )
        print(json.dumps({"state": "running"}))
    else:
        raise ValueError("invalid action")
    os.close(lock_fd)


if __name__ == "__main__":
    main()
