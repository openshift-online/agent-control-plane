from unittest.mock import Mock

from ambient_platform import RuntimeAPI


def test_runtime_patch_preserves_clear_and_version():
    client = Mock()
    client._request.return_value = {"id": "session", "runtime_version": 8}
    session = RuntimeAPI(client).patch_session("session/id", 7, {"runner_generation": None, "expected_phase": "Stopping"})
    client._request.assert_called_once_with(
        "PATCH", "/runtime/sessions/session%2Fid",
        json={"runner_generation": None, "expected_phase": "Stopping", "runtime_version": 7},
    )
    assert session.runtime_version == 8


def test_runtime_inventory_preserves_tombstones():
    client = Mock()
    client._request.return_value = {"items": [{"id": "deleted", "runtime_deleted": True}], "total": 1}
    projects = RuntimeAPI(client).projects(2, 50)
    client._request.assert_called_once_with("GET", "/runtime/projects", params={"page": 2, "size": 50})
    assert projects.items[0].runtime_deleted
