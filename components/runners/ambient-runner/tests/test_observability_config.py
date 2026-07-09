"""Tests for observability backend selection."""

import os
from unittest.mock import patch

from ambient_runner.observability_config import (
    observability_backend_names,
    use_langfuse_backend,
    use_mlflow_backend,
)


def test_default_backends_is_langfuse_only():
    with patch.dict(os.environ, {}, clear=True):
        assert observability_backend_names() == frozenset({"langfuse"})
        assert use_langfuse_backend() is True
        assert use_mlflow_backend() is False


def test_observability_backends_parsing():
    with patch.dict(
        os.environ,
        {"OBSERVABILITY_BACKENDS": "mlflow, langfuse ,unknown"},
        clear=True,
    ):
        assert observability_backend_names() == frozenset({"langfuse", "mlflow"})


def test_use_mlflow_defaults_on_when_tracking_uri_is_present():
    with patch.dict(
        os.environ,
        {"MLFLOW_TRACKING_URI": "http://mlflow:5000"},
        clear=True,
    ):
        assert use_mlflow_backend() is True


def test_use_mlflow_allows_legacy_backend_opt_in_when_enabled():
    with patch.dict(
        os.environ,
        {
            "OBSERVABILITY_BACKENDS": "mlflow",
            "MLFLOW_TRACING_ENABLED": "true",
            "MLFLOW_TRACKING_URI": "http://mlflow:5000",
        },
        clear=True,
    ):
        assert use_mlflow_backend() is True


def test_use_mlflow_requires_tracking_uri_for_legacy_backend_opt_in():
    with patch.dict(
        os.environ,
        {
            "OBSERVABILITY_BACKENDS": "mlflow",
            "MLFLOW_TRACING_ENABLED": "true",
            "MLFLOW_TRACKING_URI": "",
        },
        clear=True,
    ):
        assert use_mlflow_backend() is False


def test_explicit_false_tracing_flag_disables_mlflow():
    with patch.dict(
        os.environ,
        {
            "MLFLOW_TRACKING_URI": "http://mlflow:5000",
            "MLFLOW_TRACING_ENABLED": "false",
        },
        clear=True,
    ):
        assert use_mlflow_backend() is False


def test_mlflow_backend_ignores_backend_list_without_explicit_false():
    with patch.dict(
        os.environ,
        {
            "OBSERVABILITY_BACKENDS": "langfuse",
            "MLFLOW_TRACKING_URI": "http://mlflow:5000",
        },
        clear=True,
    ):
        assert use_mlflow_backend() is True
