import base64
import json
import os
import socket
import subprocess
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import mlflow
import pytest


pytestmark = pytest.mark.skipif(
    os.getenv("RUN_KIND_MLFLOW_E2E") != "true",
    reason="set RUN_KIND_MLFLOW_E2E=true to run against live kind and MLflow",
)


def _run(command: list[str], *, timeout: int = 30) -> str:
    return subprocess.check_output(command, text=True, timeout=timeout).strip()


def _secret_value(namespace: str, secret: str, key: str) -> str:
    encoded = _run(
        [
            "kubectl",
            "get",
            "secret",
            secret,
            "-n",
            namespace,
            "-o",
            f"jsonpath={{.data.{key}}}",
        ]
    )
    return base64.b64decode(encoded).decode().strip()


def _assert_not_exported(serialized_trace: str, marker_name: str, marker: str) -> None:
    if marker and marker in serialized_trace:
        raise AssertionError(f"{marker_name} was exported in MLflow trace payload")


def _open_port_forward() -> tuple[subprocess.Popen[str], int]:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    process = subprocess.Popen(
        [
            "kubectl",
            "port-forward",
            "-n",
            "ambient-code",
            "svc/ambient-api-server",
            f"{port}:8000",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    return process, port


def _stop_process(process: subprocess.Popen[str]) -> None:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()


def _api_request(
    api: str,
    token: str,
    method: str,
    path: str,
    body: dict[str, object] | None = None,
    timeout: int = 20,
) -> dict[str, object]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        api + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode()
        return json.loads(raw) if raw else {}


def _api_list(
    api: str,
    token: str,
    path: str,
    search: str,
    timeout: int = 20,
) -> list[dict[str, object]]:
    query = urllib.parse.urlencode({"search": search, "size": "100"})
    response = _api_request(api, token, "GET", f"{path}?{query}", timeout=timeout)
    items = response.get("items")
    assert isinstance(items, list)
    return items


def _ensure_project_mlflow_binding(api: str, token: str, project_id: str, name: str) -> None:
    roles = _api_list(api, token, "/api/ambient/v1/roles", "name = 'credential:viewer'")
    assert roles, "credential:viewer role was not found"
    role_id = str(roles[0]["id"])

    credential = _api_request(
        api,
        token,
        "POST",
        "/api/ambient/v1/credentials",
        {
            "name": name,
            "provider": "mlflow",
            "token": "vault-materialized-source-secret",
        },
    )
    credential_id = str(credential["id"])
    _api_request(
        api,
        token,
        "POST",
        "/api/ambient/v1/role_bindings",
        {
            "role_id": role_id,
            "scope": "credential",
            "credential_id": credential_id,
            "project_id": project_id,
        },
    )


def _wait_for_api(api: str, token: str) -> None:
    for _ in range(30):
        try:
            _api_request(
                api, token, "GET", "/api/ambient/v1/projects?size=1", timeout=5
            )
            return
        except Exception:
            time.sleep(1)
    raise AssertionError("ambient API port-forward did not become ready")


def _wait_for_sandbox(namespace: str, sandbox: str) -> dict[str, object]:
    for _ in range(120):
        result = subprocess.run(
            ["kubectl", "get", "sandbox", "-n", namespace, sandbox, "-o", "json"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
            check=False,
        )
        if result.returncode == 0:
            return json.loads(result.stdout)
        time.sleep(2)
    raise AssertionError(f"sandbox {namespace}/{sandbox} was not created")


def _pod_env(namespace: str, pod: str) -> dict[str, str]:
    pod_obj = _pod_json(namespace, pod)
    env = pod_obj["spec"]["containers"][0].get("env", [])
    return {item["name"]: item.get("value", "") for item in env}


def _pod_json(namespace: str, pod: str) -> dict[str, object]:
    raw = _run(["kubectl", "get", "pod", "-n", namespace, pod, "-o", "json"])
    return json.loads(raw)


def _wait_for_pod_ready(namespace: str, pod: str) -> None:
    last_state = ""
    for _ in range(120):
        try:
            pod_obj = _pod_json(namespace, pod)
            phase = pod_obj.get("status", {}).get("phase")
            node_name = pod_obj.get("spec", {}).get("nodeName")
            statuses = pod_obj.get("status", {}).get("containerStatuses") or []
            ready = bool(statuses and statuses[0].get("ready"))
            last_state = f"phase={phase} node={node_name} ready={ready}"
            if phase == "Running" and node_name and ready:
                return
        except Exception as exc:
            last_state = str(exc)
        time.sleep(2)
    raise AssertionError(f"pod {namespace}/{pod} was not ready: {last_state}")


def _wait_for_pod_env(namespace: str, pod: str) -> dict[str, str]:
    last_error = None
    for _ in range(60):
        try:
            return _pod_env(namespace, pod)
        except Exception as exc:
            last_error = exc
            time.sleep(2)
    raise AssertionError(f"pod {namespace}/{pod} was not queryable: {last_error}")


def _copy_runner_ca_bundle(
    namespace: str, pod: str, path: str, output_path: str
) -> None:
    bundle = _run(["kubectl", "exec", "-n", namespace, pod, "--", "cat", path])
    assert "BEGIN CERTIFICATE" in bundle
    with open(output_path, "w", encoding="utf-8") as handle:
        handle.write(bundle)


def _find_mlflow_trace(
    monkeypatch: pytest.MonkeyPatch,
    experiment_name: str,
    session_id: str,
    nonce: str,
    ca_bundle: str,
    tracking_uri: str,
    tracking_token: str,
) -> tuple[str, str, str]:
    monkeypatch.setenv("MLFLOW_TRACKING_URI", tracking_uri)
    monkeypatch.setenv("MLFLOW_EXPERIMENT_NAME", experiment_name)
    monkeypatch.setenv("MLFLOW_TRACKING_TOKEN", tracking_token)
    monkeypatch.setenv("REQUESTS_CA_BUNDLE", ca_bundle)
    monkeypatch.setenv("SSL_CERT_FILE", ca_bundle)
    monkeypatch.delenv("MLFLOW_TRACKING_INSECURE_TLS", raising=False)
    monkeypatch.setenv("MLFLOW_HTTP_REQUEST_TIMEOUT", "15")
    monkeypatch.setenv("MLFLOW_HTTP_REQUEST_MAX_RETRIES", "1")

    mlflow.set_tracking_uri(tracking_uri)
    client = mlflow.MlflowClient(tracking_uri=tracking_uri)
    experiment = client.get_experiment_by_name(experiment_name)
    assert experiment is not None

    for _ in range(36):
        traces = mlflow.search_traces(
            experiment_ids=[experiment.experiment_id],
            max_results=100,
        )
        for _, row in traces.iterrows():
            tags = row.get("tags") or {}
            if tags.get("ambient.session_id") == session_id:
                serialized_trace = row.to_json()
                _assert_not_exported(serialized_trace, "nonce", nonce)
                _assert_not_exported(
                    serialized_trace, "MLflow tracking token", tracking_token
                )
                assert tags.get("mlflow.traceName") == "llm_interaction"
                assert tags.get("ambient.namespace") == "tenant-a"
                assert row.get("state") == "OK"
                return (
                    str(row.get("trace_id")),
                    str(experiment.experiment_id),
                    str(row.get("request_time")),
                )
        time.sleep(10)
    raise AssertionError(f"no MLflow trace found for session {session_id}")


def test_kind_runner_turn_exports_trace_to_mlflow(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    api_token = _secret_value("ambient-code", "test-user-token", "token")
    mlflow_token = _secret_value("ambient-code", "mlflow", "MLFLOW_TRACKING_TOKEN")
    assert len(mlflow_token) >= 8

    port_forward, port = _open_port_forward()
    session_id = ""
    try:
        api = f"http://127.0.0.1:{port}"
        _wait_for_api(api, api_token)

        nonce = "acp-mlflow-e2e-" + datetime.now(timezone.utc).strftime(
            "%Y%m%dT%H%M%SZ"
        )
        _ensure_project_mlflow_binding(
            api, api_token, "tenant-a", f"{nonce}-mlflow-credential"
        )
        session = _api_request(
            api,
            api_token,
            "POST",
            "/api/ambient/v1/sessions",
            {"name": nonce, "project_id": "tenant-a"},
        )
        session_id = str(session["id"])
        _api_request(
            api, api_token, "POST", f"/api/ambient/v1/sessions/{session_id}/start"
        )

        namespace = "tenant-a"
        sandbox = "session-" + session_id.lower()
        sandbox_obj = _wait_for_sandbox(namespace, sandbox)
        container = sandbox_obj["spec"]["podTemplate"]["spec"]["containers"][0]
        assert container["image"] == "localhost/acp_runner_openshell:latest"

        pod_env = _wait_for_pod_env(namespace, sandbox)
        assert pod_env["MLFLOW_TRACKING_URI"].startswith("https://")
        assert pod_env["MLFLOW_EXPERIMENT_NAME"] == "acp-general"
        assert pod_env["MLFLOW_TRACING_ENABLED"] == "true"
        assert pod_env["MLFLOW_ENABLE_ASYNC_TRACE_LOGGING"] == "true"
        assert pod_env["MLFLOW_GENAI_AUTOLOG_INTEGRATIONS"] == "anthropic,openai"
        assert (
            pod_env["MLFLOW_TRACKING_TOKEN"]
            == "openshell:resolve:env:MLFLOW_TRACKING_TOKEN"
        )
        assert pod_env.get("MLFLOW_TRACKING_INSECURE_TLS") in (None, "")
        assert pod_env["REQUESTS_CA_BUNDLE"] == pod_env["SSL_CERT_FILE"]

        _wait_for_pod_ready(namespace, sandbox)
        ca_bundle = str(tmp_path / "runner-ca-bundle.pem")
        _copy_runner_ca_bundle(
            namespace, sandbox, pod_env["REQUESTS_CA_BUNDLE"], ca_bundle
        )

        _api_request(
            api,
            api_token,
            "POST",
            f"/api/ambient/v1/sessions/{session_id}/messages",
            {
                "event_type": "user",
                "payload": f"{nonce}: reply with exactly pong.",
            },
        )

        trace_id, experiment_id, request_time = _find_mlflow_trace(
            monkeypatch,
            "acp-general",
            session_id,
            nonce,
            ca_bundle,
            pod_env["MLFLOW_TRACKING_URI"],
            mlflow_token,
        )
        print(f"session_id={session_id}")
        print(f"trace_id={trace_id}")
        print(f"experiment_id={experiment_id}")
        print(f"request_time={request_time}")
    finally:
        _stop_process(port_forward)
