from __future__ import annotations

import json
import logging
import os
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Self

import grpc

from ambient_runner.platform.utils import set_bot_token

logger = logging.getLogger(__name__)

_ENV_GRPC_URL = "AMBIENT_GRPC_URL"
_ENV_TOKEN = "BOT_TOKEN"
_ENV_CP_TOKEN_URL = "AMBIENT_CP_TOKEN_URL"
_ENV_BOOTSTRAP_TOKEN_NAME = "AMBIENT_RUNNER_BOOTSTRAP_TOKEN"
_ENV_SESSION_ID = "SESSION_ID"
_ENV_USE_TLS = "AMBIENT_GRPC_USE_TLS"
_ENV_CA_CERT = "AMBIENT_GRPC_CA_CERT_FILE"
_DEFAULT_GRPC_URL = "ambient-api-server:9000"
_SERVICE_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt"
_SA_TOKEN_FILE = Path("/var/run/secrets/kubernetes.io/serviceaccount/token")


_CP_TOKEN_FETCH_ATTEMPTS = 30
_CP_TOKEN_FETCH_TIMEOUT = 10


def _validate_cp_token_url(url: str) -> None:
    """Reject non-http(s) or credential-bearing URLs to prevent exfiltration."""
    parsed = urllib.parse.urlparse(url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise RuntimeError(
            "invalid CP token URL (must be http/https with no credentials)"
        )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("CP token endpoint redirects are not permitted")


def _fetch_token_from_cp(cp_token_url: str, bootstrap_token: str) -> str:
    """Exchange a session capability for a short-lived runner access token."""
    _validate_cp_token_url(cp_token_url)
    if not bootstrap_token:
        raise RuntimeError("AMBIENT_RUNNER_BOOTSTRAP_TOKEN is required")
    if (
        urllib.parse.urlparse(cp_token_url).scheme != "https"
        and os.getenv("AMBIENT_ALLOW_INSECURE_RUNNER_TRANSPORT") != "true"
    ):
        raise RuntimeError("runner token exchange requires HTTPS")
    ca_file = os.getenv("AMBIENT_CP_CA_CERT_FILE") or None
    context = _tls_context(ca_file, "configured CP")
    opener = urllib.request.build_opener(
        _NoRedirect(), urllib.request.HTTPSHandler(context=context)
    )
    for attempt in range(_CP_TOKEN_FETCH_ATTEMPTS):
        if attempt:
            time.sleep(2)
        try:
            req = urllib.request.Request(
                cp_token_url,
                headers={"Authorization": f"Bearer {bootstrap_token}"},
            )
            with opener.open(req, timeout=_CP_TOKEN_FETCH_TIMEOUT) as resp:
                body = json.loads(resp.read(16384))
            token = body.get("token", "")
            if not isinstance(token, str) or not token.startswith("acp-runner-v1."):
                raise RuntimeError("CP response has no scoped runner token")
            set_bot_token(token)
            return token
        except urllib.error.HTTPError as exc:
            if exc.code < 500:
                raise RuntimeError(
                    f"CP token exchange rejected: HTTP {exc.code}"
                ) from None
        except urllib.error.URLError:
            pass
    raise RuntimeError("CP token endpoint unavailable")


def _tls_context(ca_cert_file: str | None, source: str) -> ssl.SSLContext:
    """Add the ACP CA to default trust, including the sandbox proxy CA."""
    context = ssl.create_default_context()
    if ca_cert_file:
        try:
            context.load_verify_locations(cafile=ca_cert_file)
        except OSError as exc:
            raise RuntimeError(
                f"{source} CA file cannot be read or is invalid"
            ) from exc
    return context


def _load_ca_cert(ca_cert_file: str | None) -> bytes:
    """Export native, system, and ACP trust for gRPC's separate TLS library."""
    source = "configured gRPC"
    if not ca_cert_file and os.path.exists(_SERVICE_CA_PATH):
        ca_cert_file = _SERVICE_CA_PATH
        source = "service"
    context = _tls_context(ca_cert_file, source)
    certificates = context.get_ca_certs(binary_form=True)
    if not certificates:
        raise RuntimeError("gRPC CA trust store is empty")
    return "".join(ssl.DER_cert_to_PEM_cert(cert) for cert in certificates).encode()


def _build_channel(
    grpc_url: str, use_tls: bool = False, ca_cert_file: str | None = None
) -> grpc.Channel:
    """Build transport; session RPC wrappers supply one bearer header per call."""
    logger.info(
        "[GRPC CHANNEL] Building channel: url=%s tls=%s ca_cert=%s",
        grpc_url,
        use_tls,
        ca_cert_file,
    )
    if use_tls:
        ca_cert = _load_ca_cert(ca_cert_file)
        channel_creds = grpc.ssl_channel_credentials(root_certificates=ca_cert)
        # The RPC wrappers add Authorization on both TLS and explicit local
        # plaintext transports. Adding channel call credentials duplicates it.
        return grpc.secure_channel(grpc_url, channel_creds)
    logger.info("[GRPC CHANNEL] Using insecure channel (no TLS)")
    return grpc.insecure_channel(grpc_url)


class AmbientGRPCClient:
    """gRPC client for the Ambient Platform internal API.

    Intended for use inside runner Job pods where BOT_TOKEN and
    AMBIENT_GRPC_URL are injected by the operator.
    """

    def __init__(
        self,
        grpc_url: str,
        token: str,
        use_tls: bool = False,
        ca_cert_file: str | None = None,
        cp_token_url: str = "",
    ) -> None:
        self._grpc_url = grpc_url
        self._token = token
        self._use_tls = use_tls
        self._ca_cert_file = ca_cert_file
        self._cp_token_url = cp_token_url
        self._channel: grpc.Channel | None = None
        self._session_messages: SessionMessagesAPI | None = None  # noqa: F821
        self._session_events: SessionEventsAPI | None = None  # noqa: F821

    @classmethod
    def from_env(cls) -> AmbientGRPCClient:
        """Create client from environment variables."""
        grpc_url = os.environ.get(_ENV_GRPC_URL, _DEFAULT_GRPC_URL)
        cp_token_url = os.environ.get(_ENV_CP_TOKEN_URL, "")
        use_tls = os.environ.get(_ENV_USE_TLS, "").lower() in ("true", "1", "yes")
        ca_cert_file = os.environ.get(_ENV_CA_CERT)
        if cp_token_url:
            if (
                not use_tls
                and os.getenv("AMBIENT_ALLOW_INSECURE_RUNNER_TRANSPORT") != "true"
            ):
                raise RuntimeError("runner gRPC connection requires TLS")
            token = _fetch_token_from_cp(
                cp_token_url, os.environ.get(_ENV_BOOTSTRAP_TOKEN_NAME, "")
            )
        else:
            token = os.environ.get(_ENV_TOKEN, "")
            logger.info("[GRPC CLIENT] Using BOT_TOKEN env var (local dev mode)")
        logger.info(
            "[GRPC CLIENT] Initializing from env: url=%s tls=%s token_len=%d",
            grpc_url,
            use_tls,
            len(token),
        )
        return cls(
            grpc_url=grpc_url,
            token=token,
            use_tls=use_tls,
            ca_cert_file=ca_cert_file,
            cp_token_url=cp_token_url,
        )

    def reconnect(self) -> None:
        """Close the existing channel and rebuild with a fresh token from the CP endpoint."""
        if self._cp_token_url:
            fresh_token = _fetch_token_from_cp(
                self._cp_token_url, os.environ.get(_ENV_BOOTSTRAP_TOKEN_NAME, "")
            )
        else:
            fresh_token = os.environ.get(_ENV_TOKEN, "")
        logger.info(
            "[GRPC CLIENT] Reconnecting with fresh token (len=%d)", len(fresh_token)
        )
        self.close()
        self._token = fresh_token

    def _get_channel(self) -> grpc.Channel:
        if self._channel is None:
            logger.info("[GRPC CHANNEL] Creating new channel to %s", self._grpc_url)
            self._channel = _build_channel(
                self._grpc_url, self._use_tls, self._ca_cert_file
            )
            logger.info("[GRPC CHANNEL] Channel created successfully")
        return self._channel

    @property
    def session_messages(self) -> SessionMessagesAPI:  # noqa: F821
        if self._session_messages is None:
            logger.info("[GRPC CLIENT] Creating SessionMessagesAPI stub")
            from ._session_messages_api import SessionMessagesAPI

            self._session_messages = SessionMessagesAPI(
                self._get_channel(), token=self._token, grpc_client=self
            )
            logger.info("[GRPC CLIENT] SessionMessagesAPI ready")
        return self._session_messages

    @property
    def session_events(self) -> SessionEventsAPI:  # noqa: F821
        if self._session_events is None:
            logger.info("[GRPC CLIENT] Creating SessionEventsAPI stub")
            from ._session_events_api import SessionEventsAPI

            self._session_events = SessionEventsAPI(
                self._get_channel(), token=self._token, grpc_client=self
            )
            logger.info("[GRPC CLIENT] SessionEventsAPI ready")
        return self._session_events

    def close(self) -> None:
        if self._channel is not None:
            self._channel.close()
            self._channel = None
            self._session_messages = None
            self._session_events = None

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()
