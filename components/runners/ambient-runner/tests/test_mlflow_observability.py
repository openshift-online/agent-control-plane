"""Tests for MLflowSessionTracer (mlflow_observability.py)."""

import os
import sys
import types
from unittest.mock import MagicMock, patch

import pytest

_mock_mlflow = types.ModuleType("mlflow")
_mock_mlflow.set_tracking_uri = MagicMock()
_mock_mlflow.set_experiment = MagicMock()
_mock_mlflow.flush_trace_async_logging = MagicMock()
_mock_entities = types.ModuleType("mlflow.entities")
_mock_entities.SpanStatusCode = MagicMock()
_mock_entities.SpanType = MagicMock()
_mock_mlflow.entities = _mock_entities

from ambient_runner.mlflow_observability import MLflowSessionTracer  # noqa: E402


INIT_KWARGS = dict(
    prompt="hello",
    namespace="ns",
    model="claude-sonnet-4-20250514",
    workflow_url="",
    workflow_branch="",
    workflow_path="",
    mask_fn=None,
)


@pytest.fixture(autouse=True)
def _mock_mlflow_modules():
    _mock_mlflow.set_tracking_uri.reset_mock()
    _mock_mlflow.set_experiment.reset_mock()
    _mock_mlflow.set_tracking_uri.side_effect = None
    _mock_mlflow.set_experiment.side_effect = None
    with (
        patch.dict(
            sys.modules,
            {
                "mlflow": _mock_mlflow,
                "mlflow.entities": _mock_entities,
            },
        ),
        patch(
            "ambient_runner.observability_config.check_mlflow_tracking_reachable",
            return_value=True,
        ),
    ):
        yield


class TestIsOpenshellToken:
    def test_recognizes_resolve_prefix(self):
        assert (
            MLflowSessionTracer._is_openshell_token(
                "openshell:resolve:env:MLFLOW_TRACKING_URI"
            )
            is True
        )

    def test_rejects_normal_url(self):
        assert (
            MLflowSessionTracer._is_openshell_token("https://mlflow.example.com")
            is False
        )

    def test_rejects_empty_string(self):
        assert MLflowSessionTracer._is_openshell_token("") is False

    def test_rejects_partial_prefix(self):
        assert MLflowSessionTracer._is_openshell_token("openshell:resolve:") is False


class TestInitializeTracking:
    def test_standard_uri_calls_set_tracking_uri_and_set_experiment(self):
        env = {
            "MLFLOW_TRACKING_URI": "https://mlflow.example.com",
            "MLFLOW_EXPERIMENT_NAME": "my-experiment",
        }
        with patch.dict(os.environ, env, clear=True):
            tracer = MLflowSessionTracer("s1", "u1", "user1")
            result = tracer.initialize(**INIT_KWARGS)

        assert result is True
        assert tracer.enabled is True
        _mock_mlflow.set_tracking_uri.assert_called_once_with(
            "https://mlflow.example.com"
        )
        _mock_mlflow.set_experiment.assert_called_once_with("my-experiment")

    def test_empty_tracking_uri_disables(self):
        with patch.dict(os.environ, {}, clear=True):
            tracer = MLflowSessionTracer("s1", "u1", "user1")
            result = tracer.initialize(**INIT_KWARGS)

        assert result is False
        assert tracer.enabled is False

    def test_set_tracking_uri_exception_disables(self):
        _mock_mlflow.set_tracking_uri.side_effect = Exception("connection refused")
        env = {
            "MLFLOW_TRACKING_URI": "https://mlflow.example.com",
            "MLFLOW_EXPERIMENT_NAME": "exp",
        }
        try:
            with patch.dict(os.environ, env, clear=True):
                tracer = MLflowSessionTracer("s1", "u1", "user1")
                result = tracer.initialize(**INIT_KWARGS)

            assert result is False
            assert tracer.enabled is False
        finally:
            _mock_mlflow.set_tracking_uri.side_effect = None

    def test_default_experiment_name_used_when_env_empty(self):
        env = {
            "MLFLOW_TRACKING_URI": "https://mlflow.example.com",
        }
        with patch.dict(os.environ, env, clear=True):
            tracer = MLflowSessionTracer("s1", "u1", "user1")
            result = tracer.initialize(**INIT_KWARGS)

        assert result is True
        _mock_mlflow.set_experiment.assert_called_once_with("ambient-code-sessions")

    def test_openshell_auth_mode_not_logged(self):
        env = {
            "MLFLOW_TRACKING_URI": "openshell:resolve:env:MLFLOW_TRACKING_URI",
            "MLFLOW_TRACKING_AUTH": "openshell:resolve:env:MLFLOW_TRACKING_AUTH",
        }
        with (
            patch.dict(os.environ, env, clear=True),
            patch("ambient_runner.mlflow_observability.logger") as mock_logger,
        ):
            tracer = MLflowSessionTracer("s1", "u1", "user1")
            tracer.initialize(**INIT_KWARGS)

        auth_info_calls = [
            c
            for c in mock_logger.info.call_args_list
            if "MLFLOW_TRACKING_AUTH=" in str(c)
        ]
        assert len(auth_info_calls) == 0
