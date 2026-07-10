"""Tests for MLflow tracking URI DNS pre-check."""

import socket
import time
from unittest.mock import patch

import pytest

import ambient_runner.observability_config as config_mod
from ambient_runner.observability_config import check_mlflow_tracking_reachable


@pytest.fixture(autouse=True)
def _clear_dns_cache():
    config_mod._mlflow_dns_cache.clear()
    yield
    config_mod._mlflow_dns_cache.clear()


class TestDnsPrecheck:
    def test_unresolvable_hostname_returns_false(self):
        with patch(
            "ambient_runner.observability_config.socket.getaddrinfo",
            side_effect=socket.gaierror("Name or service not known"),
        ):
            assert check_mlflow_tracking_reachable("https://nonexistent.example.invalid:443") is False

    def test_resolvable_hostname_returns_true(self):
        with patch(
            "ambient_runner.observability_config.socket.getaddrinfo",
            return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.2.3.4", 443))],
        ):
            assert check_mlflow_tracking_reachable("https://mlflow.example.com") is True

    def test_timeout_returns_false(self):
        with patch(
            "ambient_runner.observability_config.socket.getaddrinfo",
            side_effect=lambda *a, **kw: time.sleep(10),
        ):
            assert check_mlflow_tracking_reachable("https://slow.example.com", timeout=0.01) is False

    def test_cached_result_returned_without_repeat_lookup(self):
        with patch(
            "ambient_runner.observability_config.socket.getaddrinfo",
            return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.2.3.4", 443))],
        ) as mock_resolve:
            uri = "https://mlflow.example.com"
            assert check_mlflow_tracking_reachable(uri) is True
            assert check_mlflow_tracking_reachable(uri) is True
            mock_resolve.assert_called_once()

    def test_cached_failure_returned_without_repeat_lookup(self):
        with patch(
            "ambient_runner.observability_config.socket.getaddrinfo",
            side_effect=socket.gaierror("Name or service not known"),
        ) as mock_resolve:
            uri = "https://bad.example.invalid"
            assert check_mlflow_tracking_reachable(uri) is False
            assert check_mlflow_tracking_reachable(uri) is False
            mock_resolve.assert_called_once()

    def test_file_uri_bypasses_check(self):
        with patch(
            "ambient_runner.observability_config.socket.getaddrinfo",
        ) as mock_resolve:
            assert check_mlflow_tracking_reachable("file:///tmp/mlruns") is True
            mock_resolve.assert_not_called()

    def test_sqlite_uri_bypasses_check(self):
        with patch(
            "ambient_runner.observability_config.socket.getaddrinfo",
        ) as mock_resolve:
            assert check_mlflow_tracking_reachable("sqlite:///mlflow.db") is True
            mock_resolve.assert_not_called()

    def test_default_https_port_used_when_not_specified(self):
        with patch(
            "ambient_runner.observability_config.socket.getaddrinfo",
            return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.2.3.4", 443))],
        ) as mock_resolve:
            check_mlflow_tracking_reachable("https://mlflow.example.com")
            mock_resolve.assert_called_once_with("mlflow.example.com", 443)

    def test_explicit_port_used(self):
        with patch(
            "ambient_runner.observability_config.socket.getaddrinfo",
            return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.2.3.4", 5000))],
        ) as mock_resolve:
            check_mlflow_tracking_reachable("http://mlflow.local:5000")
            mock_resolve.assert_called_once_with("mlflow.local", 5000)

    def test_http_default_port_80(self):
        with patch(
            "ambient_runner.observability_config.socket.getaddrinfo",
            return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.2.3.4", 80))],
        ) as mock_resolve:
            check_mlflow_tracking_reachable("http://mlflow.local")
            mock_resolve.assert_called_once_with("mlflow.local", 80)


class TestDnsCheckIntegrationWithAutolog:
    def test_unreachable_host_prevents_autolog_activation(self):
        import ambient_runner.mlflow_autolog as autolog_mod

        autolog_mod._activated = False
        try:
            with patch(
                "ambient_runner.observability_config.socket.getaddrinfo",
                side_effect=socket.gaierror("Name or service not known"),
            ):
                import os

                with patch.dict(
                    os.environ,
                    {"MLFLOW_TRACKING_URI": "https://unreachable.example.invalid"},
                    clear=True,
                ):
                    result = autolog_mod.activate_mlflow_autologging()

            assert result is False
        finally:
            autolog_mod._activated = False
