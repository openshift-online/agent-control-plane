"""Side-effect-free runner permission checks with the caller's user token."""

from __future__ import annotations

from typing import TYPE_CHECKING
from urllib.parse import quote

if TYPE_CHECKING:
    from .client import AmbientClient


def check_runner_access(client: AmbientClient, session_id: str, method: str, action: str = "") -> None:
    """Check the session action. Use action="stop" for a POST task stop."""
    if method not in ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"):
        raise ValueError("unsupported runner access method")
    if action and (action != "stop" or method != "POST"):
        raise ValueError("unsupported runner access action")
    suffix = "/stop" if action else ""
    client._request(method, f"/sessions/{quote(session_id, safe='')}/runner/access{suffix}")
