"""MLflow SDK autologging activation."""

from collections.abc import Mapping
import importlib
import logging
import os
from typing import Any, Protocol

logger = logging.getLogger(__name__)

_DEFAULT_EXPERIMENT_NAME = "ambient-code-sessions"
_DEFAULT_GENAI_INTEGRATIONS = ("anthropic", "openai")
_EXPLICIT_FALSE_VALUES = ("0", "false", "no", "off")
_BASE_AUTOLOG_TAGS = {
    "acp.runner": "ambient-runner",
}
_ENV_TAGS = (
    ("SESSION_ID", "acp.session_id"),
    ("PROJECT_NAME", "acp.project_id"),
    ("AGENT_ID", "acp.agent_id"),
    ("RUNNER_TYPE", "acp.runner_type"),
)

_activated = False


class MLflowModule(Protocol):
    def set_tracking_uri(self, uri: str) -> None: ...

    def set_experiment(self, experiment_name: str) -> None: ...

    def autolog(
        self,
        *,
        log_models: bool,
        log_datasets: bool,
        log_traces: bool,
        silent: bool,
        extra_tags: Mapping[str, str],
        exclude_flavors: list[str],
    ) -> None: ...


def _mask_span_payloads(span: Any) -> Any:
    from ambient_runner.observability_privacy import resolve_message_mask_fn

    mask_fn = resolve_message_mask_fn()
    if mask_fn is None:
        return span
    inputs = getattr(span, "inputs", None)
    outputs = getattr(span, "outputs", None)
    if inputs is not None and hasattr(span, "set_inputs"):
        span.set_inputs(mask_fn(inputs))
    if outputs is not None and hasattr(span, "set_outputs"):
        span.set_outputs(mask_fn(outputs))
    return span


def _explicitly_false_env(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in _EXPLICIT_FALSE_VALUES


def _explicitly_disabled() -> bool:
    return _explicitly_false_env("MLFLOW_TRACING_ENABLED")


def _parse_csv_env(name: str, default: tuple[str, ...] = ()) -> list[str]:
    raw = os.getenv(name, "").strip()
    if not raw:
        return list(default)
    return [part.strip() for part in raw.split(",") if part.strip()]


def _autolog_tags(extra_tags: Mapping[str, str] | None) -> dict[str, str]:
    tags = dict(_BASE_AUTOLOG_TAGS)
    for env_name, tag_name in _ENV_TAGS:
        value = os.getenv(env_name, "").strip()
        if value:
            tags[tag_name] = value
    if extra_tags is not None:
        for name, value in extra_tags.items():
            if value:
                tags[name] = value
    return tags


def _configure_tracking(mlflow_module: MLflowModule, tracking_uri: str) -> bool:
    from ambient_runner.observability_config import check_mlflow_tracking_reachable

    if not check_mlflow_tracking_reachable(tracking_uri):
        return False

    experiment_name = (
        os.getenv("MLFLOW_EXPERIMENT_NAME", _DEFAULT_EXPERIMENT_NAME).strip()
        or _DEFAULT_EXPERIMENT_NAME
    )
    try:
        mlflow_module.set_tracking_uri(tracking_uri)
        mlflow_module.set_experiment(experiment_name)
        return True
    except Exception:
        logger.warning(
            "MLflow autologging: tracking URI or experiment setup failed; "
            "continuing with autologging enabled"
        )
        return True


def _configure_async_logging(mlflow_module: MLflowModule) -> None:
    if _explicitly_false_env("MLFLOW_ENABLE_ASYNC_TRACE_LOGGING"):
        return
    mlflow_config = getattr(mlflow_module, "config", None)
    enable_async_logging = getattr(mlflow_config, "enable_async_logging", None)
    if enable_async_logging is None:
        return
    try:
        enable_async_logging()
    except Exception:
        logger.warning(
            "MLflow autologging: async trace logging setup failed; continuing"
        )


def _configure_trace_masking(mlflow_module: Any) -> bool:
    from ambient_runner.observability_privacy import resolve_message_mask_fn

    if resolve_message_mask_fn() is None:
        return True
    tracing = getattr(mlflow_module, "tracing", None)
    configure = getattr(tracing, "configure", None)
    if configure is None:
        logger.warning("MLflow autologging disabled: trace masking API unavailable")
        return False
    try:
        configure(span_processors=[_mask_span_payloads])
    except Exception:
        logger.warning("MLflow autologging disabled: trace masking setup failed")
        return False
    return True


def _activate_generic_autolog(
    mlflow_module: MLflowModule,
    extra_tags: Mapping[str, str] | None,
) -> bool:
    exclude_flavors = _parse_csv_env("MLFLOW_AUTOLOG_EXCLUDE_FLAVORS")
    try:
        mlflow_module.autolog(
            log_models=False,
            log_datasets=True,
            log_traces=True,
            silent=False,
            extra_tags=_autolog_tags(extra_tags),
            exclude_flavors=exclude_flavors,
        )
        return True
    except Exception:
        logger.warning("MLflow autologging: generic mlflow.autolog activation failed")
        return False


def _activate_genai_autologging(mlflow_module: MLflowModule) -> bool:
    activated = False
    excluded_flavors = set(_parse_csv_env("MLFLOW_AUTOLOG_EXCLUDE_FLAVORS"))
    for integration in _parse_csv_env(
        "MLFLOW_GENAI_AUTOLOG_INTEGRATIONS",
        _DEFAULT_GENAI_INTEGRATIONS,
    ):
        if integration in excluded_flavors:
            logger.debug("MLflow autologging: integration %s is excluded", integration)
            continue
        try:
            integration_module = importlib.import_module(f"mlflow.{integration}")
        except ImportError:
            integration_module = getattr(mlflow_module, integration, None)
        autolog = getattr(integration_module, "autolog", None)
        if autolog is None:
            logger.debug(
                "MLflow autologging: integration %s is unavailable", integration
            )
            continue
        try:
            autolog()
            activated = True
        except Exception:
            logger.warning(
                "MLflow autologging: %s autolog activation failed",
                integration,
            )
    return activated


def activate_mlflow_autologging(extra_tags: Mapping[str, str] | None = None) -> bool:
    global _activated
    if _activated:
        return True

    if _explicitly_disabled():
        logger.info("MLflow autologging disabled by MLFLOW_TRACING_ENABLED=false")
        return False

    tracking_uri = os.getenv("MLFLOW_TRACKING_URI", "").strip()
    if not tracking_uri:
        return False

    try:
        import mlflow
    except ImportError:
        logger.warning("MLflow autologging requested but mlflow is not installed")
        return False

    if not _configure_tracking(mlflow, tracking_uri):
        return False
    _configure_async_logging(mlflow)
    if not _configure_trace_masking(mlflow):
        return False
    generic_enabled = _activate_generic_autolog(mlflow, extra_tags)
    genai_enabled = _activate_genai_autologging(mlflow)
    _activated = generic_enabled or genai_enabled
    if _activated:
        logger.info("MLflow autologging activated")
    else:
        logger.warning("MLflow autologging was requested but no integration activated")
    return _activated
