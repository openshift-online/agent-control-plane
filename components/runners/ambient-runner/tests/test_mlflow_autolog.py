import os
from unittest.mock import MagicMock, patch

import pytest

import ambient_runner.mlflow_autolog as autolog_mod
from ambient_runner.mlflow_autolog import activate_mlflow_autologging


@pytest.fixture(autouse=True)
def _reset_activated():
    autolog_mod._activated = False
    yield
    autolog_mod._activated = False


@pytest.fixture(autouse=True)
def _bypass_dns_check():
    with patch(
        "ambient_runner.observability_config.check_mlflow_tracking_reachable",
        return_value=True,
    ):
        yield


def test_tracking_uri_default_activates_generic_and_genai_autologging():
    mock_mlflow = MagicMock()
    mock_mlflow.anthropic = MagicMock()
    mock_mlflow.openai = MagicMock()
    env = {
        "MLFLOW_TRACKING_URI": "https://mlflow.example.com",
        "MLFLOW_AUTOLOG_EXCLUDE_FLAVORS": "sklearn, xgboost",
        "SESSION_ID": "session-1",
        "PROJECT_NAME": "project-1",
        "AGENT_ID": "agent-1",
        "RUNNER_TYPE": "claude",
    }

    with (
        patch.dict(os.environ, env, clear=True),
        patch.dict("sys.modules", {"mlflow": mock_mlflow}),
    ):
        assert activate_mlflow_autologging() is True

    mock_mlflow.set_tracking_uri.assert_called_once_with("https://mlflow.example.com")
    mock_mlflow.set_experiment.assert_called_once_with("ambient-code-sessions")
    mock_mlflow.config.enable_async_logging.assert_called_once()
    mock_mlflow.autolog.assert_called_once_with(
        log_models=False,
        log_datasets=True,
        log_traces=True,
        silent=False,
        extra_tags={
            "acp.runner": "ambient-runner",
            "acp.session_id": "session-1",
            "acp.project_id": "project-1",
            "acp.agent_id": "agent-1",
            "acp.runner_type": "claude",
        },
        exclude_flavors=["sklearn", "xgboost"],
    )
    mock_mlflow.anthropic.autolog.assert_called_once()
    mock_mlflow.openai.autolog.assert_called_once()
    mock_mlflow.tracing.configure.assert_called_once()


def test_trace_masking_processor_redacts_autolog_span_payloads():
    mock_mlflow = MagicMock()
    env = {"MLFLOW_TRACKING_URI": "https://mlflow.example.com"}

    with (
        patch.dict(os.environ, env, clear=True),
        patch.dict("sys.modules", {"mlflow": mock_mlflow}),
    ):
        assert activate_mlflow_autologging() is True

    processor = mock_mlflow.tracing.configure.call_args.kwargs["span_processors"][0]
    span = MagicMock()
    span.inputs = {
        "messages": [
            {
                "role": "user",
                "content": "this is a long private prompt that must not be exported verbatim",
            }
        ]
    }
    span.outputs = {
        "text": "this is a long private assistant response that must not be exported verbatim"
    }

    assert processor(span) is span

    span.set_inputs.assert_called_once_with(
        {"messages": [{"role": "user", "content": "[REDACTED FOR PRIVACY]"}]}
    )
    span.set_outputs.assert_called_once_with({"text": "[REDACTED FOR PRIVACY]"})


def test_trace_masking_failure_disables_autologging_when_masking_enabled():
    mock_mlflow = MagicMock()
    mock_mlflow.tracing.configure.side_effect = RuntimeError("configure failed")
    env = {"MLFLOW_TRACKING_URI": "https://mlflow.example.com"}

    with (
        patch.dict(os.environ, env, clear=True),
        patch.dict("sys.modules", {"mlflow": mock_mlflow}),
    ):
        assert activate_mlflow_autologging() is False

    mock_mlflow.autolog.assert_not_called()
    mock_mlflow.anthropic.autolog.assert_not_called()


def test_trace_masking_can_be_disabled_explicitly():
    mock_mlflow = MagicMock()
    mock_mlflow.tracing.configure.side_effect = RuntimeError("configure failed")
    env = {
        "MLFLOW_TRACKING_URI": "https://mlflow.example.com",
        "LANGFUSE_MASK_MESSAGES": "false",
    }

    with (
        patch.dict(os.environ, env, clear=True),
        patch.dict("sys.modules", {"mlflow": mock_mlflow}),
    ):
        assert activate_mlflow_autologging() is True

    mock_mlflow.tracing.configure.assert_not_called()
    mock_mlflow.autolog.assert_called_once()


def test_extra_tags_override_environment_tags():
    mock_mlflow = MagicMock()
    env = {
        "MLFLOW_TRACKING_URI": "https://mlflow.example.com",
        "SESSION_ID": "env-session",
    }

    with (
        patch.dict(os.environ, env, clear=True),
        patch.dict("sys.modules", {"mlflow": mock_mlflow}),
    ):
        assert (
            activate_mlflow_autologging(
                extra_tags={"acp.session_id": "context-session", "acp.model": "sonnet"}
            )
            is True
        )

    _, kwargs = mock_mlflow.autolog.call_args
    assert kwargs["extra_tags"]["acp.session_id"] == "context-session"
    assert kwargs["extra_tags"]["acp.model"] == "sonnet"


def test_explicit_false_tracing_flag_disables_autologging():
    env = {
        "MLFLOW_TRACKING_URI": "https://mlflow.example.com",
        "MLFLOW_TRACING_ENABLED": "false",
    }
    with patch.dict(os.environ, env, clear=True):
        assert activate_mlflow_autologging() is False


def test_missing_tracking_uri_disables_autologging():
    with patch.dict(os.environ, {}, clear=True):
        assert activate_mlflow_autologging() is False


def test_tracking_setup_failure_does_not_block_autologging():
    mock_mlflow = MagicMock()
    mock_mlflow.set_experiment.side_effect = RuntimeError("server unavailable")

    with (
        patch.dict(
            os.environ,
            {"MLFLOW_TRACKING_URI": "https://mlflow.example.com"},
            clear=True,
        ),
        patch.dict("sys.modules", {"mlflow": mock_mlflow}),
    ):
        assert activate_mlflow_autologging() is True

    mock_mlflow.autolog.assert_called_once()


def test_generic_autolog_failure_still_attempts_genai_autologging():
    mock_mlflow = MagicMock()
    mock_mlflow.autolog.side_effect = RuntimeError("unsupported flavor")
    mock_mlflow.anthropic = MagicMock()

    with (
        patch.dict(
            os.environ,
            {"MLFLOW_TRACKING_URI": "https://mlflow.example.com"},
            clear=True,
        ),
        patch.dict("sys.modules", {"mlflow": mock_mlflow}),
    ):
        assert activate_mlflow_autologging() is True

    mock_mlflow.anthropic.autolog.assert_called_once()


def test_genai_integration_env_limits_provider_autologging():
    mock_mlflow = MagicMock()
    mock_mlflow.anthropic = MagicMock()
    mock_mlflow.openai = MagicMock()
    env = {
        "MLFLOW_TRACKING_URI": "https://mlflow.example.com",
        "MLFLOW_GENAI_AUTOLOG_INTEGRATIONS": "openai",
    }

    with (
        patch.dict(os.environ, env, clear=True),
        patch.dict("sys.modules", {"mlflow": mock_mlflow}),
    ):
        assert activate_mlflow_autologging() is True

    mock_mlflow.openai.autolog.assert_called_once()
    mock_mlflow.anthropic.autolog.assert_not_called()


def test_excluded_flavor_skips_provider_autologging():
    mock_mlflow = MagicMock()
    mock_mlflow.anthropic = MagicMock()
    mock_mlflow.openai = MagicMock()
    env = {
        "MLFLOW_TRACKING_URI": "https://mlflow.example.com",
        "MLFLOW_AUTOLOG_EXCLUDE_FLAVORS": "openai",
    }

    with (
        patch.dict(os.environ, env, clear=True),
        patch.dict("sys.modules", {"mlflow": mock_mlflow}),
    ):
        assert activate_mlflow_autologging() is True

    mock_mlflow.anthropic.autolog.assert_called_once()
    mock_mlflow.openai.autolog.assert_not_called()


def test_genai_integration_is_imported_before_autologging():
    mock_mlflow = MagicMock()
    imported_anthropic = MagicMock()
    env = {
        "MLFLOW_TRACKING_URI": "https://mlflow.example.com",
        "MLFLOW_GENAI_AUTOLOG_INTEGRATIONS": "anthropic",
    }

    with (
        patch.dict(os.environ, env, clear=True),
        patch.dict("sys.modules", {"mlflow": mock_mlflow}),
        patch(
            "ambient_runner.mlflow_autolog.importlib.import_module",
            return_value=imported_anthropic,
        ) as import_module,
    ):
        assert activate_mlflow_autologging() is True

    import_module.assert_called_once_with("mlflow.anthropic")
    imported_anthropic.autolog.assert_called_once()


def test_idempotent_second_call_does_not_repatch():
    mock_mlflow = MagicMock()
    env = {"MLFLOW_TRACKING_URI": "https://mlflow.example.com"}

    with (
        patch.dict(os.environ, env, clear=True),
        patch.dict("sys.modules", {"mlflow": mock_mlflow}),
    ):
        assert activate_mlflow_autologging() is True
        assert activate_mlflow_autologging() is True

    mock_mlflow.autolog.assert_called_once()
