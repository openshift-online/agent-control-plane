"""MLflow Claude SDK autologging activation.

Independent of the OBSERVABILITY_BACKENDS config — gated solely on the three
MLflow credential env vars injected by the mlflow credential provider.
"""

import logging
import os

logger = logging.getLogger(__name__)

_REQUIRED_ENV_VARS = (
    "MLFLOW_TRACKING_URI",
    "MLFLOW_TRACKING_TOKEN",
    "MLFLOW_EXPERIMENT_NAME",
)

_activated = False


class MLflowRequiredError(RuntimeError):
    pass


def activate_mlflow_autologging() -> bool:
    """Activate MLflow Claude SDK autologging if all credential env vars are set.

    Returns True if autologging was activated, False if skipped.
    Raises MLflowRequiredError when MLFLOW_REQUIRED=true and env vars are missing.
    """
    global _activated
    if _activated:
        return True

    missing = [v for v in _REQUIRED_ENV_VARS if not os.environ.get(v)]

    if missing:
        if os.environ.get("MLFLOW_REQUIRED", "").lower() == "true":
            raise MLflowRequiredError(
                f"MLFLOW_REQUIRED=true but missing env vars: {', '.join(missing)}"
            )
        if any(os.environ.get(v) for v in _REQUIRED_ENV_VARS):
            logger.warning(
                "MLflow autologging disabled — missing env vars: %s",
                ", ".join(missing),
            )
        return False

    tracking_uri = os.environ["MLFLOW_TRACKING_URI"]
    experiment_name = os.environ["MLFLOW_EXPERIMENT_NAME"]

    try:
        import mlflow

        mlflow.set_tracking_uri(tracking_uri)
        mlflow.set_experiment(experiment_name)
        mlflow.anthropic.autolog()
        _activated = True
        logger.info(
            "MLflow autologging activated: experiment=%s, uri=%s",
            experiment_name,
            tracking_uri,
        )
        return True
    except Exception:
        logger.warning("MLflow autologging activation failed — continuing without tracing", exc_info=True)
        return False
