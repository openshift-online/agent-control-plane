"""Which observability backends are active (Langfuse, MLflow)."""

from __future__ import annotations

import logging
import os
import socket
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

_DNS_CHECK_TIMEOUT = 5.0
_NON_NETWORK_SCHEMES = frozenset({"file", "sqlite"})

_mlflow_dns_cache: dict[str, bool] = {}


def _truthy_env(name: str) -> bool:
    """Return True when the given env var is set to a common affirmative value."""
    return os.getenv(name, "").strip().lower() in ("1", "true", "yes")


def _explicitly_false_env(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in ("0", "false", "no", "off")


def check_mlflow_tracking_reachable(
    tracking_uri: str, timeout: float = _DNS_CHECK_TIMEOUT
) -> bool:
    """Fast DNS pre-check for the MLflow tracking URI hostname.

    Returns True if the hostname resolves or if the URI uses a non-network
    scheme (file://, sqlite://). Returns cached result on subsequent calls
    for the same URI.
    """
    parsed = urlparse(tracking_uri)

    if parsed.scheme in _NON_NETWORK_SCHEMES or not parsed.hostname:
        return True

    if tracking_uri in _mlflow_dns_cache:
        return _mlflow_dns_cache[tracking_uri]

    host = parsed.hostname
    port = parsed.port or (443 if parsed.scheme == "https" else 80)

    executor = ThreadPoolExecutor(max_workers=1)
    try:
        future = executor.submit(socket.getaddrinfo, host, port)
        future.result(timeout=timeout)
        _mlflow_dns_cache[tracking_uri] = True
        return True
    except FuturesTimeoutError:
        logger.warning(
            "MLflow: DNS resolution for %s timed out after %.0fs — skipping MLflow initialization",
            host,
            timeout,
        )
    except socket.gaierror as e:
        logger.warning(
            "MLflow: DNS resolution failed for %s (%s) — skipping MLflow initialization",
            host,
            e,
        )
    except Exception as e:
        logger.warning(
            "MLflow: DNS pre-check failed for %s (%s) — skipping MLflow initialization",
            host,
            e,
        )
    finally:
        executor.shutdown(wait=False, cancel_futures=True)

    _mlflow_dns_cache[tracking_uri] = False
    return False


def observability_backend_names() -> frozenset[str]:
    """Parsed OBSERVABILITY_BACKENDS, or default ``langfuse`` only.

    Values (comma-separated, case-insensitive): ``langfuse``, ``mlflow``.
    Empty/unset means **langfuse** only for backward compatibility.
    """
    raw = os.getenv("OBSERVABILITY_BACKENDS", "").strip().lower()
    if not raw:
        return frozenset({"langfuse"})
    parts = {p.strip() for p in raw.split(",") if p.strip()}
    allowed = {"langfuse", "mlflow"}
    return frozenset(p for p in parts if p in allowed)


def use_langfuse_backend() -> bool:
    """True when ``langfuse`` is included in the active observability backends."""
    return "langfuse" in observability_backend_names()


def use_mlflow_backend() -> bool:
    if _explicitly_false_env("MLFLOW_TRACING_ENABLED"):
        return False
    return bool(os.getenv("MLFLOW_TRACKING_URI", "").strip())
