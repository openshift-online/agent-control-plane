from __future__ import annotations

import json
import os
import ssl
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

import grpc
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
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
        tls.assert_called_once_with()
        tls.return_value.load_verify_locations.assert_called_once_with(
            cafile="/tmp/ca.pem"
        )


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


@pytest.fixture
def tls_certificates(tmp_path, monkeypatch):
    """Issue distinct native, ACP, and untrusted certificates for real TLS."""
    certificates = {}
    now = datetime.now(timezone.utc)
    for name in ("native", "acp", "untrusted"):
        ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
        ca = (
            x509.CertificateBuilder()
            .subject_name(issuer)
            .issuer_name(issuer)
            .public_key(ca_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=1))
            .not_valid_after(now + timedelta(hours=1))
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), True)
            .sign(ca_key, hashes.SHA256())
        )
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        leaf = (
            x509.CertificateBuilder()
            .subject_name(
                x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
            )
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=1))
            .not_valid_after(now + timedelta(hours=1))
            .add_extension(
                x509.SubjectAlternativeName([x509.DNSName("localhost")]), False
            )
            .sign(ca_key, hashes.SHA256())
        )
        paths = {}
        for kind, data in (
            ("ca", ca.public_bytes(serialization.Encoding.PEM)),
            ("cert", leaf.public_bytes(serialization.Encoding.PEM)),
            (
                "key",
                key.private_bytes(
                    serialization.Encoding.PEM,
                    serialization.PrivateFormat.PKCS8,
                    serialization.NoEncryption(),
                ),
            ),
        ):
            path = tmp_path / f"{name}-{kind}.pem"
            path.write_bytes(data)
            paths[kind] = path
        certificates[name] = paths
    monkeypatch.setenv("SSL_CERT_FILE", str(certificates["native"]["ca"]))
    monkeypatch.setenv("AMBIENT_CP_CA_CERT_FILE", str(certificates["acp"]["ca"]))
    monkeypatch.setenv("NO_PROXY", "localhost,127.0.0.1")
    monkeypatch.setenv("no_proxy", "localhost,127.0.0.1")
    monkeypatch.setattr("ambient_runner._grpc_client._CP_TOKEN_FETCH_ATTEMPTS", 1)
    return certificates


@contextmanager
def token_tls_server(certificates):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"token": TEST_RUNNER_IDENTITY}).encode())

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificates["cert"], certificates["key"])
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"https://localhost:{server.server_port}/token"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.mark.parametrize("issuer", ["native", "acp"])
def test_token_exchange_trusts_native_and_additional_ca(tls_certificates, issuer):
    with token_tls_server(tls_certificates[issuer]) as url:
        assert _fetch_token_from_cp(url, "bootstrap-capability") == TEST_RUNNER_IDENTITY


def test_token_exchange_rejects_untrusted_ca(tls_certificates):
    with token_tls_server(tls_certificates["untrusted"]) as url:
        with pytest.raises(RuntimeError, match="endpoint unavailable"):
            _fetch_token_from_cp(url, "bootstrap-capability")


def test_token_exchange_still_checks_hostname(tls_certificates):
    with token_tls_server(tls_certificates["native"]) as url:
        with pytest.raises(RuntimeError, match="endpoint unavailable"):
            _fetch_token_from_cp(
                url.replace("localhost", "127.0.0.1"), "bootstrap-capability"
            )


@pytest.mark.parametrize("issuer", ["native", "acp", "untrusted"])
def test_grpc_handshake_uses_combined_trust(tls_certificates, issuer):
    from ambient_runner._grpc_client import _build_channel, _load_ca_cert

    additional = str(tls_certificates["acp"]["ca"])
    roots = x509.load_pem_x509_certificates(_load_ca_cert(additional))
    subjects = {root.subject.rfc4514_string() for root in roots}
    assert {"CN=native", "CN=acp"} <= subjects
    assert "CN=untrusted" not in subjects
    certificate = tls_certificates[issuer]
    with ThreadPoolExecutor(max_workers=1) as pool:
        server = grpc.server(pool)
        server.add_generic_rpc_handlers(
            (
                grpc.method_handlers_generic_handler(
                    "proof.TLS",
                    {
                        "Ping": grpc.unary_unary_rpc_method_handler(
                            lambda data, ctx: data
                        )
                    },
                ),
            )
        )
        port = server.add_secure_port(
            "127.0.0.1:0",
            grpc.ssl_server_credentials(
                ((certificate["key"].read_bytes(), certificate["cert"].read_bytes()),)
            ),
        )
        server.start()
        try:
            with _build_channel(f"localhost:{port}", "", True, additional) as channel:
                call = channel.unary_unary("/proof.TLS/Ping")
                if issuer == "untrusted":
                    with pytest.raises(grpc.RpcError) as caught:
                        call(b"proof", timeout=3)
                    assert caught.value.code() == grpc.StatusCode.UNAVAILABLE
                else:
                    assert call(b"proof", timeout=3) == b"proof"
        finally:
            server.stop(0).wait(timeout=3)


@pytest.mark.parametrize("contents", [b"", b"not a certificate"])
def test_invalid_additional_ca_fails_before_connection(tmp_path, monkeypatch, contents):
    from ambient_runner._grpc_client import _load_ca_cert

    path = tmp_path / "invalid.pem"
    path.write_bytes(contents)
    monkeypatch.setenv("AMBIENT_CP_CA_CERT_FILE", str(path))
    with patch("urllib.request.build_opener") as opener:
        with pytest.raises(RuntimeError, match="CA file cannot be read or is invalid"):
            _fetch_token_from_cp("https://cp.example/token", "bootstrap-capability")
        opener.assert_not_called()
    with pytest.raises(RuntimeError, match="CA file cannot be read or is invalid"):
        _load_ca_cert(str(path))


def test_grpc_service_ca_adds_to_native_trust(tls_certificates, monkeypatch):
    from ambient_runner._grpc_client import _load_ca_cert

    monkeypatch.setattr(
        "ambient_runner._grpc_client._SERVICE_CA_PATH",
        str(tls_certificates["acp"]["ca"]),
    )
    roots = x509.load_pem_x509_certificates(_load_ca_cert(None))
    assert {"CN=native", "CN=acp"} <= {root.subject.rfc4514_string() for root in roots}
