"""
Claude-specific authentication — Vertex AI and Anthropic API key setup.

Framework-agnostic credential fetching lives in ``ambient_runner.platform.auth``.
This module adds Claude Agent SDK-specific concerns:
- Vertex AI model mapping and credential setup
- SDK authentication environment variable population
"""

import logging
import os

from ambient_runner.platform.auth import validate_vertex_credentials_file
from ambient_runner.platform.context import RunnerContext
from ambient_runner.platform.utils import is_vertex_enabled

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Vertex AI model mapping
# ---------------------------------------------------------------------------

VERTEX_MODEL_MAP: dict[str, str] = {
    "claude-opus-4-6": "claude-opus-4-6@default",
    "claude-opus-4-5": "claude-opus-4-5@20251101",
    "claude-opus-4-1": "claude-opus-4-1@20250805",
    "claude-sonnet-4-6": "claude-sonnet-4-6@default",
    "claude-sonnet-4-5": "claude-sonnet-4-5@20250929",
    "claude-haiku-4-5": "claude-haiku-4-5@20251001",
}


def map_to_vertex_model(model: str) -> str:
    """Map Anthropic API model names to Vertex AI model names."""
    return VERTEX_MODEL_MAP.get(model, model)


async def setup_vertex_credentials(context: RunnerContext) -> dict:
    """Set up Google Cloud Vertex AI credentials from service account."""
    service_account_path = validate_vertex_credentials_file(context)
    project_id = context.get_env("ANTHROPIC_VERTEX_PROJECT_ID", "").strip()
    region = context.get_env("CLOUD_ML_REGION", "").strip()

    if not project_id:
        raise RuntimeError(
            "ANTHROPIC_VERTEX_PROJECT_ID must be set when USE_VERTEX is enabled"
        )
    if not region:
        raise RuntimeError("CLOUD_ML_REGION must be set when USE_VERTEX is enabled")

    logger.info(f"Vertex AI configured: project={project_id}, region={region}")
    return {
        "credentials_path": service_account_path,
        "project_id": project_id,
        "region": region,
    }


def _is_inference_routing_enabled(context: RunnerContext) -> bool:
    """Check if OpenShell inference routing is active."""
    val = context.get_env("ACP_OPENSHELL_INFERENCE", "")
    return val.strip().lower() in ("1", "true", "yes")


async def setup_sdk_authentication(context: RunnerContext) -> tuple[str, bool, str]:
    """Set up SDK auth env vars for the Claude Agent SDK.

    Returns:
        (api_key, use_vertex, configured_model)
    """
    api_key = context.get_env("ANTHROPIC_API_KEY", "")
    use_vertex = is_vertex_enabled(legacy_var="CLAUDE_CODE_USE_VERTEX", context=context)
    inference_routing = _is_inference_routing_enabled(context)

    if not api_key and not use_vertex and not inference_routing:
        raise RuntimeError(
            "Either ANTHROPIC_API_KEY, USE_VERTEX=1, or ACP_OPENSHELL_INFERENCE=true must be set"
        )

    model = context.get_env("LLM_MODEL")

    DEFAULT_MODEL = "claude-sonnet-4-6"
    DEFAULT_VERTEX_MODEL = "claude-sonnet-4-6@default"

    if inference_routing:
        # OpenShell inference routing: ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY,
        # HTTPS_PROXY, and TLS CA vars are set at the sandbox level by the
        # control plane reconciler and the OpenShell supervisor. The runner
        # only needs to read them and clear any Vertex flags that would cause
        # the SDK to bypass the proxy.
        for key in ("USE_VERTEX", "CLAUDE_CODE_USE_VERTEX"):
            os.environ.pop(key, None)
        configured_model = model or DEFAULT_MODEL
        api_key = os.environ.get("ANTHROPIC_API_KEY", "inference-routing")
        logger.info(
            f"Using OpenShell inference routing via inference.local (model={configured_model})"
        )
        return api_key, False, configured_model

    if api_key and not use_vertex:
        os.environ["ANTHROPIC_API_KEY"] = api_key
        configured_model = model or DEFAULT_MODEL
        logger.info(
            f"Using Anthropic API key authentication (model={configured_model})"
        )

    elif use_vertex:
        vertex_credentials = await setup_vertex_credentials(context)
        os.environ["ANTHROPIC_API_KEY"] = "vertex-auth-mode"
        os.environ["USE_VERTEX"] = "1"
        os.environ["CLAUDE_CODE_USE_VERTEX"] = "1"  # kept for Claude Code CLI compat
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = vertex_credentials.get(
            "credentials_path", ""
        )
        os.environ["ANTHROPIC_VERTEX_PROJECT_ID"] = vertex_credentials.get(
            "project_id", ""
        )
        os.environ["CLOUD_ML_REGION"] = vertex_credentials.get("region", "")
        vertex_id_from_manifest = (context.get_env("LLM_MODEL_VERTEX_ID") or "").strip()
        if vertex_id_from_manifest:
            configured_model = vertex_id_from_manifest
            logger.info(
                f"Using Vertex AI authentication with manifest vertex ID (model={configured_model})"
            )
        elif model:
            configured_model = map_to_vertex_model(model)
            logger.info(f"Using Vertex AI authentication (model={configured_model})")
        else:
            configured_model = DEFAULT_VERTEX_MODEL
            logger.info(
                f"Using Vertex AI authentication with default (model={configured_model})"
            )

    else:
        configured_model = model or DEFAULT_MODEL

    return api_key, use_vertex, configured_model
