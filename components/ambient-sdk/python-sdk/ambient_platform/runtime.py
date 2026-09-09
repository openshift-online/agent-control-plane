"""Service-only runtime inventory and versioned updates."""

from __future__ import annotations

from typing import TYPE_CHECKING, Mapping
from urllib.parse import quote

from .project import Project, ProjectList
from .session import Session, SessionList

if TYPE_CHECKING:
    from .client import AmbientClient


class RuntimeAPI:
    """Use with the configured control plane identity. Includes deleted records."""

    def __init__(self, client: AmbientClient) -> None:
        self._client = client

    def projects(self, page: int = 1, size: int = 100) -> ProjectList:
        response = self._client._request("GET", "/runtime/projects", params={"page": page, "size": size})
        return ProjectList.from_dict(response)

    def sessions(self, page: int = 1, size: int = 100) -> SessionList:
        response = self._client._request("GET", "/runtime/sessions", params={"page": page, "size": size})
        return SessionList.from_dict(response)

    def patch_project(self, resource_id: str, version: int, fields: Mapping[str, str | None]) -> Project:
        response = self._client._request(
            "PATCH", f"/runtime/projects/{quote(resource_id, safe='')}",
            json={**fields, "runtime_version": version},
        )
        return Project.from_dict(response)

    def patch_session(self, resource_id: str, version: int, fields: Mapping[str, str | None]) -> Session:
        response = self._client._request(
            "PATCH", f"/runtime/sessions/{quote(resource_id, safe='')}",
            json={**fields, "runtime_version": version},
        )
        return Session.from_dict(response)
