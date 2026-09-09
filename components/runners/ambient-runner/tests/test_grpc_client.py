from __future__ import annotations

import json
import os
import urllib.error
from unittest.mock import MagicMock, patch

import pytest

from ambient_runner._grpc_client import (
    AmbientGRPCClient,
    _fetch_token_from_cp,
    _NoRedirect,
    _validate_cp_token_url,
)


EMPTY_CACHE_VALUE = ""
TEST_RUNNER_IDENTITY = "acp-runner-v1.access.signature"


@pytest.fixture(autouse=True)
def token_cache():
    from ambient_runner.platform import utils

    utils._cp_fetched_token = EMPTY_CACHE_VALUE
    yield
    utils._cp_fetched_token = EMPTY_CACHE_VALUE


def response(token=None):
    if token is None:
        token = TEST_RUNNER_IDENTITY
    result = MagicMock()
    result.read.return_value = json.dumps({"token": token}).encode()
    result.__enter__.return_value = result
    result.__exit__.return_value = False
    return result


@pytest.mark.parametrize(
    "url",
    ["", "file:///tmp/token", "ftp://cp/token", "http://u:p@cp/token", "http:///token"],
)
def test_invalid_callback_urls(url):
    with pytest.raises(RuntimeError, match="invalid CP token URL"):
        _validate_cp_token_url(url)


def test_exchange_sends_capability_and_caches_scoped_token():
    from ambient_runner.platform.utils import get_bot_token

    with patch("urllib.request.build_opener") as build:
        build.return_value.open.return_value = response()
        token = _fetch_token_from_cp("https://cp.example/token", "bootstrap-capability")
        request = build.return_value.open.call_args.args[0]
        assert request.get_header("Authorization") == "Bearer bootstrap-capability"
    assert token == "acp-runner-v1.access.signature"
    assert get_bot_token() == token


def test_missing_capability_cannot_use_public_session_id():
    with pytest.raises(RuntimeError, match="BOOTSTRAP_TOKEN is required"):
        _fetch_token_from_cp("https://cp.example/token", "")


def test_token_exchange_requires_tls():
    with (
        patch.dict(os.environ, {"AMBIENT_ALLOW_INSECURE_RUNNER_TRANSPORT": ""}),
        pytest.raises(RuntimeError, match="requires HTTPS"),
    ):
        _fetch_token_from_cp("http://cp.example/token", "bootstrap-capability")


def test_redirects_do_not_forward_capability():
    with pytest.raises(RuntimeError, match="redirects are not permitted"):
        _NoRedirect().redirect_request(
            None, None, 302, "", {}, "https://attacker.example"
        )


def test_exchange_rejects_broad_token_response():
    with patch("urllib.request.build_opener") as build:
        build.return_value.open.return_value = response("service-token")
        with pytest.raises(RuntimeError, match="no scoped runner token"):
            _fetch_token_from_cp("https://cp.example/token", "bootstrap-capability")


@pytest.mark.parametrize("code", [401, 403])
def test_revocation_does_not_retry_or_show_response_body(code):
    error = urllib.error.HTTPError(
        "https://cp.example/token", code, "secret", None, None
    )
    with patch("urllib.request.build_opener") as build:
        build.return_value.open.side_effect = error
        with pytest.raises(RuntimeError, match=f"HTTP {code}") as caught:
            _fetch_token_from_cp("https://cp.example/token", "bootstrap-capability")
        assert "secret" not in str(caught.value)
        assert build.return_value.open.call_count == 1


def test_transient_connection_failure_retries():
    with patch("urllib.request.build_opener") as build, patch("time.sleep"):
        build.return_value.open.side_effect = [
            urllib.error.URLError("refused"),
            response(),
        ]
        _fetch_token_from_cp("https://cp.example/token", "bootstrap-capability")
        assert build.return_value.open.call_count == 2


def test_configured_ca_is_used():
    with (
        patch.dict(os.environ, {"AMBIENT_CP_CA_CERT_FILE": "/tmp/ca.pem"}),
        patch("ssl.create_default_context") as tls,
        patch("urllib.request.build_opener") as build,
    ):
        build.return_value.open.return_value = response()
        _fetch_token_from_cp("https://cp.example/token", "bootstrap-capability")
        tls.assert_called_once_with(cafile="/tmp/ca.pem")


def test_reconnect_refreshes_with_same_scoped_capability():
    env = {
        "AMBIENT_GRPC_URL": "api.example:443",
        "AMBIENT_GRPC_USE_TLS": "true",
        "AMBIENT_CP_TOKEN_URL": "https://cp.example/token",
        "AMBIENT_RUNNER_BOOTSTRAP_TOKEN": "bootstrap-capability",
    }
    with (
        patch.dict(os.environ, env, clear=True),
        patch("urllib.request.build_opener") as build,
    ):
        build.return_value.open.side_effect = [
            response(),
            response("acp-runner-v1.refreshed.signature"),
        ]
        client = AmbientGRPCClient.from_env()
        client.reconnect()
        assert client._token == "acp-runner-v1.refreshed.signature"
        for call in build.return_value.open.call_args_list:
            assert (
                call.args[0].get_header("Authorization")
                == "Bearer bootstrap-capability"
            )


def test_failed_refresh_has_no_cached_token_fallback():
    from ambient_runner.platform.utils import refresh_bot_token, set_bot_token

    set_bot_token("old-token")
    with (
        patch.dict(
            os.environ, {"AMBIENT_CP_TOKEN_URL": "https://cp.example/token"}, clear=True
        ),
        pytest.raises(RuntimeError, match="BOOTSTRAP_TOKEN is required"),
    ):
        refresh_bot_token()


def test_explicit_missing_ca_fails_closed(tmp_path):
    from ambient_runner._grpc_client import _load_ca_cert

    with pytest.raises(RuntimeError, match="CA file cannot be read"):
        _load_ca_cert(str(tmp_path / "missing.pem"))


def test_token_url_error_does_not_echo_credentials():
    from ambient_runner._grpc_client import _validate_cp_token_url

    with pytest.raises(RuntimeError) as error:
        _validate_cp_token_url("https://name:private-value@example.com/token")
    assert "private-value" not in str(error.value)
