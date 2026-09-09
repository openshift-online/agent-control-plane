from unittest.mock import Mock

import pytest

from ambient_platform import check_runner_access


def test_runner_access_preserves_method_and_session():
    client = Mock()
    check_runner_access(client, "session/id", "PUT")
    client._request.assert_called_once_with("PUT", "/sessions/session%2Fid/runner/access")
    client.reset_mock()
    check_runner_access(client, "session/id", "POST", "stop")
    client._request.assert_called_once_with("POST", "/sessions/session%2Fid/runner/access/stop")


def test_runner_access_propagates_denial_and_validates_action():
    client = Mock()
    client._request.side_effect = PermissionError("denied")
    with pytest.raises(PermissionError):
        check_runner_access(client, "session", "POST")
    client.reset_mock()
    with pytest.raises(ValueError):
        check_runner_access(client, "session", "GET", "stop")
    client._request.assert_not_called()
