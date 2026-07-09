"""Tests for shared session credential scoping and cleanup."""

import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from io import BytesIO
from pathlib import Path
from threading import Thread
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.error import HTTPError

import pytest

from ambient_runner.platform.auth import (
    _GH_WRAPPER_DIR,  # noqa: F401 — used via _auth_mod in gh wrapper tests
    _GH_WRAPPER_PATH,  # noqa: F401 — used via _auth_mod in gh wrapper tests
    _GITHUB_TOKEN_FILE,
    _GITLAB_TOKEN_FILE,
    _fetch_credential,
    install_gh_wrapper,
    populate_runtime_credentials,
    sanitize_user_context,
)
from ambient_runner.platform.context import RunnerContext


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_context(
    session_id: str = "test-session",
    current_user_id: str = "",
    current_user_name: str = "",
    **env_overrides,
) -> RunnerContext:
    """Create a RunnerContext with optional current user and env overrides."""
    ctx = RunnerContext(
        session_id=session_id,
        workspace_path="/tmp/test",
        environment=env_overrides,
    )
    if current_user_id:
        ctx.set_current_user(current_user_id, current_user_name)
    return ctx


class _CredentialHandler(BaseHTTPRequestHandler):
    """HTTP handler that records request headers and returns canned credentials."""

    captured_headers: dict = {}
    response_body: dict = {}

    def do_GET(self):
        _CredentialHandler.captured_headers = dict(self.headers)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(_CredentialHandler.response_body).encode())

    def log_message(self, format, *args):
        pass  # suppress server logs in test output


# ---------------------------------------------------------------------------
# RunnerContext.set_current_user
# ---------------------------------------------------------------------------


class TestSetCurrentUser:
    def test_set_current_user_stores_values(self):
        ctx = _make_context()
        ctx.set_current_user("user-123", "Alice")
        assert ctx.current_user_id == "user-123"
        assert ctx.current_user_name == "Alice"

    def test_set_current_user_can_clear(self):
        ctx = _make_context(current_user_id="user-123", current_user_name="Alice")
        ctx.set_current_user("", "")
        assert ctx.current_user_id == ""
        assert ctx.current_user_name == ""


# ---------------------------------------------------------------------------
# sanitize_user_context
# ---------------------------------------------------------------------------


class TestSanitizeUserContext:
    def test_sanitize_normal_values(self):
        uid, uname = sanitize_user_context("user@example.com", "Alice Smith")
        assert uid == "user@example.com"
        assert uname == "Alice Smith"

    def test_sanitize_strips_control_chars(self):
        uid, uname = sanitize_user_context("user\x00id", "Al\x1fice")
        assert "\x00" not in uid
        assert "\x1f" not in uname

    def test_sanitize_truncates_long_values(self):
        long_id = "a" * 300
        uid, _ = sanitize_user_context(long_id, "")
        assert len(uid) <= 255

    def test_sanitize_empty_values(self):
        uid, uname = sanitize_user_context("", "")
        assert uid == ""
        assert uname == ""


# ---------------------------------------------------------------------------
# Token file lifecycle (mid-run refresh support)
# ---------------------------------------------------------------------------


class TestTokenFiles:
    """Token files let the git credential helper pick up mid-run refreshes.

    The CLI subprocess is spawned once and its environment is fixed at that
    point. Updating os.environ later does not propagate into the subprocess.
    Writing tokens to files allows the credential helper (which runs fresh for
    every git operation) to always use the latest token.
    """

    def _cleanup(self):
        """Remove token files created during tests."""
        _GITHUB_TOKEN_FILE.unlink(missing_ok=True)
        _GITLAB_TOKEN_FILE.unlink(missing_ok=True)

    @pytest.mark.asyncio
    async def test_populate_writes_github_token_file(self):
        """populate_runtime_credentials writes GITHUB_TOKEN to the token file."""
        self._cleanup()
        try:
            with patch("ambient_runner.platform.auth._fetch_credential") as mock_fetch:

                async def _creds(ctx, ctype):
                    if ctype == "github":
                        return {
                            "token": "gh-mid-run-token",
                            "userName": "user",
                            "email": "u@example.com",
                        }
                    return {}

                mock_fetch.side_effect = _creds
                ctx = _make_context()
                await populate_runtime_credentials(ctx)

            assert _GITHUB_TOKEN_FILE.exists()
            assert _GITHUB_TOKEN_FILE.read_text() == "gh-mid-run-token"
        finally:
            self._cleanup()
            for key in ["GITHUB_TOKEN", "GIT_USER_NAME", "GIT_USER_EMAIL"]:
                os.environ.pop(key, None)

    @pytest.mark.asyncio
    async def test_populate_writes_gitlab_token_file(self):
        """populate_runtime_credentials writes GITLAB_TOKEN to the token file."""
        self._cleanup()
        try:
            with patch("ambient_runner.platform.auth._fetch_credential") as mock_fetch:

                async def _creds(ctx, ctype):
                    if ctype == "gitlab":
                        return {
                            "token": "gl-mid-run-token",
                            "userName": "user",
                            "email": "u@example.com",
                        }
                    return {}

                mock_fetch.side_effect = _creds
                ctx = _make_context()
                await populate_runtime_credentials(ctx)

            assert _GITLAB_TOKEN_FILE.exists()
            assert _GITLAB_TOKEN_FILE.read_text() == "gl-mid-run-token"
        finally:
            self._cleanup()
            for key in ["GITLAB_TOKEN", "GIT_USER_NAME", "GIT_USER_EMAIL"]:
                os.environ.pop(key, None)

    @pytest.mark.asyncio
    async def test_second_populate_overwrites_token_file(self):
        """A second populate_runtime_credentials call overwrites the stale token file.

        This is the mid-run refresh scenario: the MCP tool calls populate again
        with a fresh token and the file must reflect the new value.
        """
        self._cleanup()
        try:
            call_num = [0]

            async def _creds(ctx, ctype):
                if ctype == "github":
                    call_num[0] += 1
                    return {
                        "token": f"gh-token-{call_num[0]}",
                        "userName": "u",
                        "email": "u@e.com",
                    }
                return {}

            with patch(
                "ambient_runner.platform.auth._fetch_credential", side_effect=_creds
            ):
                ctx = _make_context()
                await populate_runtime_credentials(ctx)
                assert _GITHUB_TOKEN_FILE.read_text() == "gh-token-1"

                await populate_runtime_credentials(ctx)
                assert _GITHUB_TOKEN_FILE.read_text() == "gh-token-2"
        finally:
            self._cleanup()
            for key in ["GITHUB_TOKEN", "GIT_USER_NAME", "GIT_USER_EMAIL"]:
                os.environ.pop(key, None)


# ---------------------------------------------------------------------------
# _fetch_credential — X-Runner-Current-User header
# ---------------------------------------------------------------------------


class TestFetchCredentialHeaders:
    @pytest.mark.asyncio
    async def test_sends_current_user_header_when_set(self):
        """Verify _fetch_credential uses caller token and sends X-Runner-Current-User when context has both."""
        server = HTTPServer(("127.0.0.1", 0), _CredentialHandler)
        port = server.server_address[1]
        thread = Thread(target=server.handle_request, daemon=True)
        thread.start()

        _CredentialHandler.response_body = {"token": "gh-token-for-userB"}
        _CredentialHandler.captured_headers = {}

        cred_id = "cred-github-001"
        try:
            with patch.dict(
                os.environ,
                {
                    "BACKEND_API_URL": f"http://127.0.0.1:{port}/api",
                    "PROJECT_NAME": "test-project",
                    "BOT_TOKEN": "fake-bot-token",
                    "CREDENTIAL_IDS": json.dumps({"github": cred_id}),
                },
            ):
                ctx = _make_context(
                    current_user_id="userB@example.com",
                    current_user_name="User B",
                )
                # Set caller token — runner uses this instead of BOT_TOKEN
                ctx.caller_token = "Bearer userB-oauth-token"
                result = await _fetch_credential(ctx, "github")

            assert result.get("token") == "gh-token-for-userB"
            assert (
                _CredentialHandler.captured_headers.get("X-Runner-Current-User")
                == "userB@example.com"
            )
            # Should use caller token, not BOT_TOKEN
            assert (
                "Bearer userB-oauth-token"
                in _CredentialHandler.captured_headers.get("Authorization", "")
            )
        finally:
            server.server_close()
            thread.join(timeout=2)

    @pytest.mark.asyncio
    async def test_omits_current_user_header_when_not_set(self):
        """Verify _fetch_credential omits X-Runner-Current-User for automated sessions."""
        server = HTTPServer(("127.0.0.1", 0), _CredentialHandler)
        port = server.server_address[1]
        thread = Thread(target=server.handle_request, daemon=True)
        thread.start()

        _CredentialHandler.response_body = {"token": "owner-token"}
        _CredentialHandler.captured_headers = {}

        cred_id = "cred-github-002"
        try:
            with patch.dict(
                os.environ,
                {
                    "BACKEND_API_URL": f"http://127.0.0.1:{port}/api",
                    "PROJECT_NAME": "test-project",
                    "BOT_TOKEN": "fake-bot-token",
                    "CREDENTIAL_IDS": json.dumps({"github": cred_id}),
                },
            ):
                ctx = _make_context()  # no current_user_id
                result = await _fetch_credential(ctx, "github")

            assert result.get("token") == "owner-token"
            # Header should NOT be present
            assert "X-Runner-Current-User" not in _CredentialHandler.captured_headers
        finally:
            server.server_close()
            thread.join(timeout=2)

    @pytest.mark.asyncio
    async def test_returns_empty_when_backend_unavailable(self):
        """Verify graceful fallback when backend is unreachable."""
        with patch.dict(
            os.environ,
            {
                "BACKEND_API_URL": "http://127.0.0.1:1/api",
                "PROJECT_NAME": "test-project",
                "CREDENTIAL_IDS": json.dumps({"github": "cred-unreachable"}),
            },
        ):
            ctx = _make_context(current_user_id="user-123")
            result = await _fetch_credential(ctx, "github")

        assert result == {}


# ---------------------------------------------------------------------------
# _fetch_credential — operator path fallback (regression for #1438)
# ---------------------------------------------------------------------------


class TestFetchCredentialOperatorPath:
    """Without CREDENTIAL_IDS the runner must fall back to the session-scoped
    backend URL used by operator-based deployments.

    The alpha migration (1aa8b428) broke this by requiring CREDENTIAL_IDS and
    silently returning {} when it was absent, leaving GITHUB_TOKEN empty.
    """

    @pytest.mark.asyncio
    async def test_falls_back_to_session_url_without_credential_ids(self):
        """_fetch_credential uses /projects/{p}/agentic-sessions/{s}/credentials/{type}
        when CREDENTIAL_IDS is not set."""
        captured = {}

        class PathCapture(BaseHTTPRequestHandler):
            def do_GET(self):
                captured["path"] = self.path
                captured["headers"] = dict(self.headers)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"token": "gh-tok-operator"}).encode())

            def log_message(self, fmt, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), PathCapture)
        port = server.server_address[1]
        thread = Thread(target=server.handle_request, daemon=True)
        thread.start()

        try:
            with (
                patch.dict(
                    os.environ,
                    {
                        "BACKEND_API_URL": f"http://127.0.0.1:{port}",
                        "PROJECT_NAME": "my-project",
                    },
                    clear=False,
                ),
                patch(
                    "ambient_runner.platform.auth.get_bot_token",
                    return_value="bot-tok",
                ),
            ):
                os.environ.pop("CREDENTIAL_IDS", None)
                ctx = _make_context(session_id="sess-42")
                result = await _fetch_credential(ctx, "github")

            assert result.get("token") == "gh-tok-operator"
            assert captured["path"] == (
                "/projects/my-project/agentic-sessions/sess-42/credentials/github"
            )
        finally:
            server.server_close()
            thread.join(timeout=2)

    @pytest.mark.asyncio
    async def test_prefers_cp_path_when_credential_ids_present(self):
        """_fetch_credential uses /api/ambient/v1/... when CREDENTIAL_IDS is set."""
        captured = {}

        class PathCapture(BaseHTTPRequestHandler):
            def do_GET(self):
                captured["path"] = self.path
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"token": "gh-tok-cp"}).encode())

            def log_message(self, fmt, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), PathCapture)
        port = server.server_address[1]
        thread = Thread(target=server.handle_request, daemon=True)
        thread.start()

        try:
            with (
                patch.dict(
                    os.environ,
                    {
                        "BACKEND_API_URL": f"http://127.0.0.1:{port}",
                        "PROJECT_NAME": "my-project",
                        "CREDENTIAL_IDS": json.dumps({"github": "cred-abc"}),
                    },
                ),
                patch(
                    "ambient_runner.platform.auth.get_bot_token",
                    return_value="bot-tok",
                ),
            ):
                ctx = _make_context(session_id="sess-42")
                result = await _fetch_credential(ctx, "github")

            assert result.get("token") == "gh-tok-cp"
            assert captured["path"] == (
                "/api/ambient/v1/projects/my-project/credentials/cred-abc/token"
            )
        finally:
            server.server_close()
            thread.join(timeout=2)

    @pytest.mark.asyncio
    async def test_returns_empty_without_project_or_session(self):
        """_fetch_credential returns {} when neither CP IDs nor session context exist."""
        with patch.dict(
            os.environ,
            {"BACKEND_API_URL": "http://127.0.0.1:1"},
            clear=False,
        ):
            os.environ.pop("CREDENTIAL_IDS", None)
            os.environ.pop("PROJECT_NAME", None)
            os.environ.pop("AGENTIC_SESSION_NAMESPACE", None)
            ctx = _make_context(session_id="")
            result = await _fetch_credential(ctx, "github")

        assert result == {}

    @pytest.mark.asyncio
    async def test_operator_path_populates_github_token(self):
        """Full round-trip: populate_runtime_credentials sets GITHUB_TOKEN via
        the operator session-scoped path when CREDENTIAL_IDS is absent."""

        class MultiHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                if "/credentials/github" in self.path:
                    body = {
                        "token": "gh-tok-from-backend",
                        "userName": "dev",
                        "email": "d@e.com",
                    }
                else:
                    body = {}
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

            def log_message(self, fmt, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), MultiHandler)
        port = server.server_address[1]
        thread = Thread(
            target=lambda: [server.handle_request() for _ in range(7)],
            daemon=True,
        )
        thread.start()

        try:
            with (
                patch.dict(
                    os.environ,
                    {
                        "BACKEND_API_URL": f"http://127.0.0.1:{port}",
                        "PROJECT_NAME": "test-project",
                        "BOT_TOKEN": "fake-bot",
                    },
                    clear=False,
                ),
                patch(
                    "ambient_runner.platform.auth.get_bot_token",
                    return_value="bot-tok",
                ),
            ):
                os.environ.pop("CREDENTIAL_IDS", None)
                ctx = _make_context(session_id="my-session")

                await populate_runtime_credentials(ctx)

                assert os.environ.get("GITHUB_TOKEN") == "gh-tok-from-backend"
        finally:
            server.server_close()
            thread.join(timeout=2)
            os.environ.pop("GITHUB_TOKEN", None)
            os.environ.pop("GIT_USER_NAME", None)
            os.environ.pop("GIT_USER_EMAIL", None)


class TestPopulateCredentialsResponseFormats:
    """Backend (operator) and control-plane return different field names.
    populate_runtime_credentials must handle both. Regression for #1438."""

    @pytest.mark.asyncio
    async def test_google_oauth_access_token_format(self):
        """Backend returns accessToken/refreshToken — must write OAuth creds file."""

        class GoogleHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                if "/credentials/google" in self.path:
                    body = {
                        "accessToken": "ya29.access",
                        "refreshToken": "1//refresh",
                        "email": "test-google@example.com",
                        "scopes": ["drive"],
                        "expiresAt": "2099-01-01T00:00:00Z",
                    }
                else:
                    body = {}
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

            def log_message(self, fmt, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), GoogleHandler)
        port = server.server_address[1]
        thread = Thread(
            target=lambda: [server.handle_request() for _ in range(7)],
            daemon=True,
        )
        thread.start()

        import tempfile

        tmp_creds_dir = Path(tempfile.mkdtemp())

        try:
            with (
                patch.dict(
                    os.environ,
                    {
                        "BACKEND_API_URL": f"http://127.0.0.1:{port}",
                        "PROJECT_NAME": "test-project",
                        "BOT_TOKEN": "fake-bot",
                    },
                    clear=False,
                ),
                patch(
                    "ambient_runner.platform.auth.get_bot_token",
                    return_value="bot-tok",
                ),
                patch(
                    "ambient_runner.platform.auth._GOOGLE_WORKSPACE_CREDS_DIR",
                    tmp_creds_dir,
                ),
                patch(
                    "ambient_runner.platform.auth._GOOGLE_WORKSPACE_LEGACY_CREDS_FILE",
                    tmp_creds_dir / "credentials.json",
                ),
            ):
                os.environ.pop("CREDENTIAL_IDS", None)
                ctx = _make_context(session_id="s1")
                await populate_runtime_credentials(ctx)

                creds_file = tmp_creds_dir / "test-google@example.com.json"
                assert creds_file.exists(), f"Expected {creds_file} to exist"
                written = json.loads(creds_file.read_text())
                assert written["token"] == "ya29.access"
                assert written["refresh_token"] == "1//refresh"
                assert written["expiry"] == "2099-01-01T00:00:00"
        finally:
            server.server_close()
            thread.join(timeout=2)
            import shutil

            shutil.rmtree(tmp_creds_dir, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_jira_api_token_format(self):
        """Backend returns apiToken — must set JIRA_API_TOKEN."""

        class JiraHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                if "/credentials/jira" in self.path:
                    body = {
                        "apiToken": "jira-legacy-tok",
                        "url": "https://jira.example.com",
                        "email": "j@e.com",
                    }
                else:
                    body = {}
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

            def log_message(self, fmt, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), JiraHandler)
        port = server.server_address[1]
        thread = Thread(
            target=lambda: [server.handle_request() for _ in range(7)],
            daemon=True,
        )
        thread.start()

        try:
            with (
                patch.dict(
                    os.environ,
                    {
                        "BACKEND_API_URL": f"http://127.0.0.1:{port}",
                        "PROJECT_NAME": "test-project",
                        "BOT_TOKEN": "fake-bot",
                    },
                    clear=False,
                ),
                patch(
                    "ambient_runner.platform.auth.get_bot_token",
                    return_value="bot-tok",
                ),
            ):
                os.environ.pop("CREDENTIAL_IDS", None)
                ctx = _make_context(session_id="s1")
                await populate_runtime_credentials(ctx)

                assert os.environ.get("JIRA_API_TOKEN") == "jira-legacy-tok"
        finally:
            server.server_close()
            thread.join(timeout=2)
            for key in ["JIRA_API_TOKEN", "JIRA_URL", "JIRA_EMAIL"]:
                os.environ.pop(key, None)


# ---------------------------------------------------------------------------
# _fetch_credential — auth failure propagation (issue #1043)
# ---------------------------------------------------------------------------


class TestFetchCredentialAuthFailures:
    @pytest.mark.asyncio
    async def test_raises_permission_error_on_401_without_caller_token(
        self, monkeypatch
    ):
        """_fetch_credential raises PermissionError when backend returns 401 with BOT_TOKEN."""
        monkeypatch.setenv("BACKEND_API_URL", "http://backend.svc.cluster.local/api")
        monkeypatch.setenv("PROJECT_NAME", "test-project")
        monkeypatch.setenv("BOT_TOKEN", "bot-token")
        monkeypatch.setenv("CREDENTIAL_IDS", json.dumps({"github": "cred-gh-001"}))

        ctx = _make_context(session_id="sess-1")

        err = HTTPError(
            "http://backend.svc.cluster.local/api/...",
            401,
            "Unauthorized",
            {},
            BytesIO(b""),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            with pytest.raises(
                PermissionError, match="authentication failed with HTTP 401"
            ):
                await _fetch_credential(ctx, "github")

    @pytest.mark.asyncio
    async def test_raises_permission_error_on_403_without_caller_token(
        self, monkeypatch
    ):
        """_fetch_credential raises PermissionError when backend returns 403 with BOT_TOKEN."""
        monkeypatch.setenv("BACKEND_API_URL", "http://backend.svc.cluster.local/api")
        monkeypatch.setenv("PROJECT_NAME", "test-project")
        monkeypatch.setenv("BOT_TOKEN", "bot-token")
        monkeypatch.setenv("CREDENTIAL_IDS", json.dumps({"google": "cred-google-001"}))

        ctx = _make_context(session_id="sess-1")

        err = HTTPError(
            "http://backend.svc.cluster.local/api/...",
            403,
            "Forbidden",
            {},
            BytesIO(b""),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            with pytest.raises(
                PermissionError, match="authentication failed with HTTP 403"
            ):
                await _fetch_credential(ctx, "google")

    @pytest.mark.asyncio
    async def test_raises_permission_error_when_caller_and_bot_both_fail(
        self, monkeypatch
    ):
        """_fetch_credential raises PermissionError when caller token 401s and BOT_TOKEN also fails."""
        monkeypatch.setenv("BACKEND_API_URL", "http://backend.svc.cluster.local/api")
        monkeypatch.setenv("PROJECT_NAME", "test-project")
        monkeypatch.setenv("BOT_TOKEN", "bot-token")
        monkeypatch.setenv("CREDENTIAL_IDS", json.dumps({"github": "cred-gh-002"}))

        ctx = _make_context(session_id="sess-1", current_user_id="user@example.com")
        ctx.caller_token = "Bearer expired-caller-token"

        caller_err = HTTPError("http://...", 401, "Unauthorized", {}, BytesIO(b""))
        fallback_err = HTTPError("http://...", 403, "Forbidden", {}, BytesIO(b""))

        with patch("urllib.request.urlopen", side_effect=[caller_err, fallback_err]):
            with pytest.raises(
                PermissionError,
                match="caller token expired and BOT_TOKEN fallback also failed",
            ):
                await _fetch_credential(ctx, "github")

    @pytest.mark.asyncio
    async def test_does_not_raise_on_non_auth_http_errors(self, monkeypatch):
        """_fetch_credential returns {} for non-auth HTTP errors (404, 500, etc.)."""
        monkeypatch.setenv("BACKEND_API_URL", "http://backend.svc.cluster.local/api")
        monkeypatch.setenv("PROJECT_NAME", "test-project")
        monkeypatch.setenv("CREDENTIAL_IDS", json.dumps({"github": "cred-gh-003"}))

        ctx = _make_context(session_id="sess-1")

        err = HTTPError("http://...", 404, "Not Found", {}, BytesIO(b""))
        with patch("urllib.request.urlopen", side_effect=err):
            result = await _fetch_credential(ctx, "github")

        assert result == {}

    @pytest.mark.asyncio
    async def test_caller_token_fallback_succeeds_when_bot_token_works(
        self, monkeypatch
    ):
        """_fetch_credential returns data when caller token 401s but BOT_TOKEN fallback succeeds."""
        monkeypatch.setenv("BACKEND_API_URL", "http://backend.svc.cluster.local/api")
        monkeypatch.setenv("PROJECT_NAME", "test-project")
        monkeypatch.setenv("BOT_TOKEN", "valid-bot-token")
        monkeypatch.setenv("CREDENTIAL_IDS", json.dumps({"github": "cred-gh-004"}))

        ctx = _make_context(session_id="sess-1", current_user_id="user@example.com")
        ctx.caller_token = "Bearer expired-caller-token"

        caller_err = HTTPError("http://...", 401, "Unauthorized", {}, BytesIO(b""))

        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps(
            {"token": "gh-tok-via-bot"}
        ).encode()
        mock_response.__enter__ = lambda s: s
        mock_response.__exit__ = MagicMock(return_value=False)

        with patch("urllib.request.urlopen", side_effect=[caller_err, mock_response]):
            result = await _fetch_credential(ctx, "github")

        assert result.get("token") == "gh-tok-via-bot"


# ---------------------------------------------------------------------------
# populate_runtime_credentials — raises on auth failure (issue #1043)
# ---------------------------------------------------------------------------


class TestPopulateRuntimeCredentialsAuthFailures:
    @pytest.mark.asyncio
    async def test_raises_when_github_auth_fails(self, monkeypatch):
        """populate_runtime_credentials raises PermissionError when GitHub auth fails."""
        monkeypatch.setenv("BACKEND_API_URL", "http://backend.svc.cluster.local/api")
        monkeypatch.setenv("PROJECT_NAME", "test-project")

        ctx = _make_context(session_id="sess-1")

        async def _fail_github(context, cred_type):
            if cred_type == "github":
                raise PermissionError("github authentication failed with HTTP 401")
            return {}

        with patch(
            "ambient_runner.platform.auth._fetch_credential", side_effect=_fail_github
        ):
            with pytest.raises(
                PermissionError,
                match="Credential refresh failed due to authentication errors",
            ):
                await populate_runtime_credentials(ctx)

    @pytest.mark.asyncio
    async def test_raises_when_multiple_providers_fail(self, monkeypatch):
        """populate_runtime_credentials raises PermissionError listing all auth failures."""
        monkeypatch.setenv("BACKEND_API_URL", "http://backend.svc.cluster.local/api")
        monkeypatch.setenv("PROJECT_NAME", "test-project")

        ctx = _make_context(session_id="sess-1")

        async def _fail_all(context, cred_type):
            raise PermissionError(f"{cred_type} authentication failed with HTTP 401")

        with patch(
            "ambient_runner.platform.auth._fetch_credential", side_effect=_fail_all
        ):
            with pytest.raises(PermissionError) as exc_info:
                await populate_runtime_credentials(ctx)

        msg = str(exc_info.value)
        assert "authentication errors" in msg

    @pytest.mark.asyncio
    async def test_succeeds_when_all_credentials_empty_no_auth_error(self, monkeypatch):
        """populate_runtime_credentials does not raise when credentials are simply missing (not auth failures)."""
        monkeypatch.setenv("BACKEND_API_URL", "http://backend.svc.cluster.local/api")
        monkeypatch.setenv("PROJECT_NAME", "test-project")

        ctx = _make_context(session_id="sess-1")

        with patch("ambient_runner.platform.auth._fetch_credential", return_value={}):
            # Should not raise — empty credentials just means no integrations configured
            await populate_runtime_credentials(ctx)


# ---------------------------------------------------------------------------
# refresh_credentials_tool — reports isError on auth failure (issue #1043)
# ---------------------------------------------------------------------------


class TestRefreshCredentialsTool:
    def _make_tool_decorator(self):
        """Create a mock sdk_tool decorator that preserves the function."""

        def mock_tool(name, description, schema):
            def decorator(func):
                return func

            return decorator

        return mock_tool

    @pytest.mark.asyncio
    async def test_returns_is_error_on_auth_failure(self):
        """refresh_credentials_tool returns isError=True when populate_runtime_credentials raises PermissionError."""
        from ambient_runner.bridges.claude.tools import create_refresh_credentials_tool

        mock_context = MagicMock()
        tool_fn = create_refresh_credentials_tool(
            mock_context, self._make_tool_decorator()
        )

        with patch(
            "ambient_runner.platform.auth.populate_runtime_credentials",
            new_callable=AsyncMock,
            side_effect=PermissionError("github authentication failed with HTTP 401"),
        ):
            result = await tool_fn({})

        assert result.get("isError") is True
        assert "github authentication failed" in result["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_returns_success_on_successful_refresh(self):
        """refresh_credentials_tool returns success message when credentials refresh succeeds."""
        from ambient_runner.bridges.claude.tools import create_refresh_credentials_tool

        mock_context = MagicMock()
        tool_fn = create_refresh_credentials_tool(
            mock_context, self._make_tool_decorator()
        )

        with (
            patch(
                "ambient_runner.platform.auth.populate_runtime_credentials",
                new_callable=AsyncMock,
            ),
            patch(
                "ambient_runner.platform.utils.get_active_integrations",
                return_value=["github", "jira"],
            ),
            patch(
                "ambient_runner.bridges.claude.tools._check_mcp_auth_after_refresh",
                return_value="",
            ),
        ):
            result = await tool_fn({})

        assert result.get("isError") is None or result.get("isError") is False
        assert "successfully" in result["content"][0]["text"].lower()

    @pytest.mark.asyncio
    async def test_includes_mcp_diagnostics_on_auth_warning(self):
        """refresh_credentials_tool includes MCP diagnostic warnings when auth issues are detected."""
        from ambient_runner.bridges.claude.tools import create_refresh_credentials_tool

        mock_context = MagicMock()
        tool_fn = create_refresh_credentials_tool(
            mock_context, self._make_tool_decorator()
        )

        with (
            patch(
                "ambient_runner.platform.auth.populate_runtime_credentials",
                new_callable=AsyncMock,
            ),
            patch(
                "ambient_runner.platform.utils.get_active_integrations",
                return_value=["github", "google"],
            ),
            patch(
                "ambient_runner.bridges.claude.tools._check_mcp_auth_after_refresh",
                return_value="google-workspace: Google OAuth token expired - re-authenticate",
            ),
        ):
            result = await tool_fn({})

        text = result["content"][0]["text"]
        assert "successfully" in text.lower()
        assert "MCP diagnostics:" in text
        assert "google-workspace" in text


# ---------------------------------------------------------------------------
# _fetch_credential — CP OIDC token used when no caller token (regression)
# ---------------------------------------------------------------------------


class TestFetchCredentialBotToken:
    @pytest.mark.asyncio
    async def test_uses_bot_token_when_no_caller_token(self):
        """_fetch_credential sends the CP OIDC token when caller_token is absent."""
        server = HTTPServer(("127.0.0.1", 0), _CredentialHandler)
        port = server.server_address[1]
        thread = Thread(target=server.handle_request, daemon=True)
        thread.start()

        _CredentialHandler.response_body = {"token": "gh-tok-via-oidc"}
        _CredentialHandler.captured_headers = {}

        cp_oidc_token = "cp-oidc-jwt-token"

        try:
            with (
                patch.dict(
                    os.environ,
                    {
                        "BACKEND_API_URL": f"http://127.0.0.1:{port}/api",
                        "PROJECT_NAME": "test-project",
                        "CREDENTIAL_IDS": json.dumps({"github": "cred-gh-bot-test"}),
                    },
                ),
                patch(
                    "ambient_runner.platform.auth.get_bot_token",
                    return_value=cp_oidc_token,
                ),
            ):
                ctx = _make_context()
                result = await _fetch_credential(ctx, "github")

            assert result.get("token") == "gh-tok-via-oidc"
            assert _CredentialHandler.captured_headers.get("Authorization") == (
                f"Bearer {cp_oidc_token}"
            )
        finally:
            server.server_close()
            thread.join(timeout=2)

    @pytest.mark.asyncio
    async def test_bot_token_used_when_no_caller_token(self):
        """CP OIDC token (get_bot_token) is used when caller_token is absent."""
        called_with = {}

        def fake_urlopen(req, timeout=None):
            called_with["auth"] = req.get_header("Authorization")
            mock_resp = MagicMock()
            mock_resp.read.return_value = json.dumps({"token": "ok"}).encode()
            mock_resp.__enter__ = lambda s: s
            mock_resp.__exit__ = MagicMock(return_value=False)
            return mock_resp

        with (
            patch.dict(
                os.environ,
                {
                    "BACKEND_API_URL": "http://backend.svc.cluster.local/api",
                    "PROJECT_NAME": "test-project",
                    "CREDENTIAL_IDS": json.dumps({"github": "cred-gh-pref"}),
                },
            ),
            patch("urllib.request.urlopen", side_effect=fake_urlopen),
            patch(
                "ambient_runner.platform.auth.get_bot_token",
                return_value="cp-oidc-token",
            ),
        ):
            ctx = _make_context()
            await _fetch_credential(ctx, "github")

        assert called_with.get("auth") == "Bearer cp-oidc-token"


# ---------------------------------------------------------------------------
# gh CLI wrapper — ensures gh picks up refreshed tokens (issue #1135)
# ---------------------------------------------------------------------------


class TestGhWrapper:
    """The gh CLI wrapper reads the latest GitHub token from the token file.

    This mirrors the git credential helper pattern: the CLI subprocess's
    environment is fixed at spawn time so env var updates don't propagate.
    The wrapper reads the token file on every invocation, ensuring `gh`
    always uses the freshest token.
    """

    @staticmethod
    def _get_auth_mod():
        import ambient_runner.platform.auth as _auth_mod

        return _auth_mod

    def _cleanup(self):
        """Remove wrapper artifacts created during tests."""
        _auth_mod = self._get_auth_mod()
        _auth_mod._gh_wrapper_installed = False
        wrapper_path = _auth_mod._GH_WRAPPER_PATH
        wrapper_dir_path = _auth_mod._GH_WRAPPER_DIR
        if wrapper_path:
            wrapper = Path(wrapper_path)
            if wrapper.is_file():
                wrapper.unlink(missing_ok=True)
        if wrapper_dir_path:
            wrapper_dir = Path(wrapper_dir_path)
            if wrapper_dir.exists() and not any(wrapper_dir.iterdir()):
                wrapper_dir.rmdir()

    def test_install_creates_executable_wrapper(self):
        """install_gh_wrapper creates an executable script at _GH_WRAPPER_PATH."""
        self._cleanup()
        try:
            _auth_mod = self._get_auth_mod()
            install_gh_wrapper()
            wrapper = Path(_auth_mod._GH_WRAPPER_PATH)
            assert wrapper.exists(), "Wrapper script should be created"
            assert os.access(str(wrapper), os.X_OK), "Wrapper should be executable"
            content = wrapper.read_text()
            assert "/tmp/.ambient_github_token" in content
            assert "GH_TOKEN" in content
        finally:
            self._cleanup()

    def test_install_prepends_to_path(self):
        """install_gh_wrapper prepends the wrapper dir to PATH."""
        self._cleanup()
        _auth_mod = self._get_auth_mod()
        original_path = os.environ.get("PATH", "")
        try:
            current_dir = _auth_mod._GH_WRAPPER_DIR
            parts = [p for p in original_path.split(":") if p != current_dir]
            os.environ["PATH"] = ":".join(parts)

            install_gh_wrapper()

            current_dir = _auth_mod._GH_WRAPPER_DIR
            current_path = os.environ.get("PATH", "")
            assert current_path.startswith(current_dir + ":"), (
                "Wrapper dir should be first in PATH"
            )
        finally:
            os.environ["PATH"] = original_path
            self._cleanup()

    def test_install_is_idempotent(self):
        """Calling install_gh_wrapper twice does not duplicate PATH entries."""
        self._cleanup()
        _auth_mod = self._get_auth_mod()
        original_path = os.environ.get("PATH", "")
        try:
            current_dir = _auth_mod._GH_WRAPPER_DIR
            parts = [p for p in original_path.split(":") if p != current_dir]
            os.environ["PATH"] = ":".join(parts)

            install_gh_wrapper()
            install_gh_wrapper()  # second call should be a no-op

            current_dir = _auth_mod._GH_WRAPPER_DIR
            current_path = os.environ.get("PATH", "")
            count = current_path.split(":").count(current_dir)
            assert count == 1, f"Wrapper dir should appear once in PATH, got {count}"
        finally:
            os.environ["PATH"] = original_path
            self._cleanup()

    @pytest.mark.asyncio
    async def test_populate_installs_gh_wrapper(self):
        """populate_runtime_credentials installs the gh wrapper."""
        self._cleanup()
        try:
            _auth_mod = self._get_auth_mod()
            with patch("ambient_runner.platform.auth._fetch_credential") as mock_fetch:

                async def _creds(ctx, ctype):
                    if ctype == "github":
                        return {
                            "token": "gh-test-token",
                            "userName": "user",
                            "email": "u@example.com",
                        }
                    return {}

                mock_fetch.side_effect = _creds
                ctx = _make_context()
                await populate_runtime_credentials(ctx)

            wrapper = Path(_auth_mod._GH_WRAPPER_PATH)
            assert wrapper.exists(), (
                "populate_runtime_credentials should install gh wrapper"
            )
        finally:
            self._cleanup()
            for key in ["GITHUB_TOKEN", "GIT_USER_NAME", "GIT_USER_EMAIL"]:
                os.environ.pop(key, None)
