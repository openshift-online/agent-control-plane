#!/usr/bin/env bash
# Check the built OpenShell runner with a UID that does not own its source.
set -euo pipefail
IMAGE="${1:?Usage: verify-runner-permissions.sh IMAGE}"
podman run --rm --network=none --userns=keep-id:uid=1000980000,gid=0 --user=1000980000:0 --read-only \
  --entrypoint /sandbox/.venv/bin/python "$IMAGE" -c '
import ast
import os
import stat
from pathlib import Path

root = Path("/runner/ambient-runner")

def fail_walk(error):
    raise error

count = 0
for directory, subdirs, files in os.walk(root, onerror=fail_walk):
    if not os.access(directory, os.R_OK | os.X_OK):
        raise RuntimeError("Source directory is not accessible: " + directory)
    for name in files:
        path = Path(directory) / name
        if not path.is_file():
            continue
        with path.open("rb") as stream:
            stream.read(1)
        if stat.S_IMODE(path.stat().st_mode) & 0o022:
            raise RuntimeError("Source grants group or other write access: " + str(path))
        count += 1
if count == 0:
    raise RuntimeError("Runner source is missing")
ast.parse((root / "main.py").read_text())
for executable in ("/runner/entrypoint.sh", "/usr/local/bin/claude"):
    if not os.access(executable, os.R_OK | os.X_OK):
        raise RuntimeError("Runner executable is not accessible: " + executable)
with open("/etc/openshell/policy.yaml", "rb") as stream:
    stream.read(1)
print("Runner source and entry points are accessible to UID", os.getuid(), "files", count)
'
