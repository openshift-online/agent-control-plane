"""Check rendered transport contracts. Run with python3 -m unittest discover -s scripts/tests -p test_manifest_tls.py.

Requires PyYAML and kubectl (or oc). This test does not contact a cluster.
"""

from pathlib import Path
import re
import shutil
import subprocess
import unittest
from urllib.parse import urlparse

import yaml


ROOT = Path(__file__).resolve().parents[2] / "components/manifests"
SECURE = (
    "base",
    "production",
    "openshift-dev",
    "local-dev",
    "openshift-local",
    "mpp-openshift",
    "hcmais",
    "hcmais-dev",
)
PLAINTEXT = ("kind", "kind-local", "e2e")


def environment(container, namespace):
    values = {}
    for item in container.get("env", []):
        if (
            item.get("valueFrom", {}).get("fieldRef", {}).get("fieldPath")
            == "metadata.namespace"
        ):
            values[item["name"]] = namespace
        elif "value" in item:
            value = str(item["value"])
            for name in re.findall(r"\$\(([^)]+)\)", value):
                if name not in values:
                    raise AssertionError(
                        f"{item['name']} uses {name} before it is defined"
                    )
                value = value.replace(f"$({name})", values[name])
            values[item["name"]] = value
    return values


class ManifestTLSTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tool = shutil.which("kubectl") or shutil.which("oc")
        if not tool:
            raise RuntimeError("kubectl or oc is required")
        cls.stacks = {}
        for name in SECURE + PLAINTEXT:
            path = ROOT / ("base" if name == "base" else f"overlays/{name}")
            result = subprocess.run(
                [tool, "kustomize", str(path)],
                check=True,
                text=True,
                capture_output=True,
            )
            cls.stacks[name] = list(yaml.safe_load_all(result.stdout))
        template = yaml.safe_load(
            (ROOT / "templates/template-services.yaml").read_text()
        )
        cls.stacks["template"] = template["objects"]

    def check_stack(self, objects, secure):
        prefix = (
            "vteam-"
            if any(
                o
                and o["kind"] == "Deployment"
                and o["metadata"]["name"] == "vteam-ambient-api-server"
                for o in objects
            )
            else ""
        )
        deployments = {
            o["metadata"]["name"].removeprefix(prefix): o
            for o in objects
            if o and o["kind"] == "Deployment"
        }
        containers = {}
        envs = {}
        for name in ("ambient-api-server", "ambient-control-plane", "ambient-ui"):
            deployment = deployments[name]
            container = deployment["spec"]["template"]["spec"]["containers"][0]
            containers[name] = container
            namespace = deployment["metadata"].get("namespace", "ambient-code")
            envs[name] = environment(container, namespace)
            for volume in deployment["spec"]["template"]["spec"].get("volumes", []):
                self.assertEqual(len(set(volume) - {"name"}), 1, volume)
        api = containers["ambient-api-server"]
        flags = dict(
            arg[2:].split("=", 1)
            for arg in api["command"]
            if arg.startswith("--") and "=" in arg
        )
        expected = "true" if secure else "false"
        self.assertEqual(flags.get("enable-tls"), expected)
        self.assertEqual(flags.get("grpc-enable-tls"), expected)
        self.assertEqual(flags.get("enable-https"), expected)
        self.assertEqual(flags.get("enable-health-check-https"), expected)
        self.assertEqual(
            envs["ambient-control-plane"]["AMBIENT_GRPC_USE_TLS"], expected
        )
        for probe in ("livenessProbe", "readinessProbe"):
            self.assertEqual(
                api[probe]["httpGet"]["scheme"], "HTTPS" if secure else "HTTP"
            )
        for name, keys in {
            "ambient-api-server": ("CONTROL_PLANE_URL",),
            "ambient-control-plane": (
                "AMBIENT_API_SERVER_URL",
                "CP_TOKEN_URL",
                "MCP_API_SERVER_URL",
            ),
            "ambient-ui": ("API_SERVER_URL", "CONTROL_PLANE_URL"),
        }.items():
            for key in keys:
                if key == "MCP_API_SERVER_URL" and key not in envs[name]:
                    continue
                url = urlparse(envs[name][key])
                self.assertEqual(url.scheme, "https" if secure else "http", (name, key))
                if secure:
                    target = (
                        "ambient-control-plane"
                        if key in ("CONTROL_PLANE_URL", "CP_TOKEN_URL")
                        else "ambient-api-server"
                    )
                    target_ns = deployments[target]["metadata"].get(
                        "namespace", "ambient-code"
                    )
                    expected_host = f"{prefix}{target}.{target_ns}.svc".lower()
                    self.assertIn(
                        url.hostname,
                        (expected_host, expected_host + ".cluster.local"),
                        (name, key),
                    )
        public_mount = next(
            m for m in api["volumeMounts"] if m["mountPath"] == "/configs/runner"
        )
        volumes = deployments["ambient-api-server"]["spec"]["template"]["spec"][
            "volumes"
        ]
        public_volume = next(v for v in volumes if v["name"] == public_mount["name"])
        self.assertEqual(
            public_volume["secret"]["items"],
            [{"key": "public.pem", "path": "public.pem"}],
        )
        if secure:
            self.assertNotEqual(
                envs["ambient-ui"].get("NODE_TLS_REJECT_UNAUTHORIZED"), "0"
            )
            for key, value in {
                "tls-cert-file": "/etc/tls/tls.crt",
                "tls-key-file": "/etc/tls/tls.key",
                "tls-min-version": "1.2",
                "tls-auto-detect-kubernetes": "false",
            }.items():
                self.assertEqual(flags.get(key), value)
            self.assertTrue(
                envs["ambient-ui"]["NODE_EXTRA_CA_CERTS"].endswith("service-ca.crt")
            )
            self.assertTrue(envs["ambient-control-plane"]["CP_TOKEN_TLS_CERT_FILE"])
            self.assertTrue(envs["ambient-control-plane"]["CP_TOKEN_TLS_KEY_FILE"])
            services = {
                o["metadata"]["name"].removeprefix(prefix): o
                for o in objects
                if o and o["kind"] == "Service"
            }
            for name in ("ambient-api-server", "ambient-control-plane"):
                self.assertTrue(
                    services[name]["metadata"]["annotations"][
                        "service.beta.openshift.io/serving-cert-secret-name"
                    ]
                )
            for route in (
                o
                for o in objects
                if o
                and o["kind"] == "Route"
                and o["spec"]["to"]["name"] == prefix + "ambient-api-server"
            ):
                self.assertEqual(route["spec"]["tls"]["termination"], "reencrypt")
        else:
            self.assertEqual(
                envs["ambient-control-plane"]["CP_TOKEN_TLS_CERT_FILE"], ""
            )
            self.assertEqual(envs["ambient-control-plane"]["CP_TOKEN_TLS_KEY_FILE"], "")
            for tls_volume in (v for v in volumes if v["name"] == "tls-certs"):
                self.assertIn("emptyDir", tls_volume)

    def test_transport_contracts(self):
        for name, objects in self.stacks.items():
            with self.subTest(stack=name):
                self.check_stack(objects, name not in PLAINTEXT)


if __name__ == "__main__":
    unittest.main()
