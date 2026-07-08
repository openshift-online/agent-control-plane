"""Tests for MLflow Claude SDK autologging activation."""

import os
from unittest.mock import MagicMock, patch

import pytest

import ambient_runner.mlflow_autolog as autolog_mod
from ambient_runner.mlflow_autolog import (
    MLflowRequiredError,
    activate_mlflow_autologging,
)

FULL_ENV = {
    "MLFLOW_TRACKING_URI": "https://mlflow.example.com",
    "MLFLOW_TRACKING_TOKEN": "test-token",
    "MLFLOW_EXPERIMENT_NAME": "test-experiment",
}


@pytest.fixture(autouse=True)
def _reset_activated():
    autolog_mod._activated = False
    yield
    autolog_mod._activated = False


def test_all_env_vars_present_activates():
    mock_mlflow = MagicMock()
    mock_mlflow.anthropic = MagicMock()

    with patch.dict(os.environ, FULL_ENV, clear=True), \
         patch.dict("sys.modules", {"mlflow": mock_mlflow}):
        assert activate_mlflow_autologging() is True

    mock_mlflow.set_tracking_uri.assert_called_once_with("https://mlflow.example.com")
    mock_mlflow.set_experiment.assert_called_once_with("test-experiment")
    mock_mlflow.anthropic.autolog.assert_called_once()


def test_missing_uri_disables():
    env = {k: v for k, v in FULL_ENV.items() if k != "MLFLOW_TRACKING_URI"}
    with patch.dict(os.environ, env, clear=True):
        assert activate_mlflow_autologging() is False


def test_missing_token_disables():
    env = {k: v for k, v in FULL_ENV.items() if k != "MLFLOW_TRACKING_TOKEN"}
    with patch.dict(os.environ, env, clear=True):
        assert activate_mlflow_autologging() is False


def test_missing_experiment_disables():
    env = {k: v for k, v in FULL_ENV.items() if k != "MLFLOW_EXPERIMENT_NAME"}
    with patch.dict(os.environ, env, clear=True):
        assert activate_mlflow_autologging() is False


def test_no_env_vars_disables_silently():
    with patch.dict(os.environ, {}, clear=True):
        assert activate_mlflow_autologging() is False


def test_mlflow_required_raises_on_missing():
    env = {"MLFLOW_REQUIRED": "true", "MLFLOW_TRACKING_URI": "https://x.com"}
    with patch.dict(os.environ, env, clear=True):
        with pytest.raises(MLflowRequiredError, match="MLFLOW_TRACKING_TOKEN"):
            activate_mlflow_autologging()


def test_mlflow_required_with_all_vars_activates():
    mock_mlflow = MagicMock()
    mock_mlflow.anthropic = MagicMock()
    env = {**FULL_ENV, "MLFLOW_REQUIRED": "true"}

    with patch.dict(os.environ, env, clear=True), \
         patch.dict("sys.modules", {"mlflow": mock_mlflow}):
        assert activate_mlflow_autologging() is True


def test_activation_exception_is_best_effort():
    mock_mlflow = MagicMock()
    mock_mlflow.set_tracking_uri.side_effect = Exception("network error")

    with patch.dict(os.environ, FULL_ENV, clear=True), \
         patch.dict("sys.modules", {"mlflow": mock_mlflow}):
        assert activate_mlflow_autologging() is False


def test_idempotent_second_call():
    mock_mlflow = MagicMock()
    mock_mlflow.anthropic = MagicMock()

    with patch.dict(os.environ, FULL_ENV, clear=True), \
         patch.dict("sys.modules", {"mlflow": mock_mlflow}):
        assert activate_mlflow_autologging() is True
        assert activate_mlflow_autologging() is True

    mock_mlflow.anthropic.autolog.assert_called_once()
