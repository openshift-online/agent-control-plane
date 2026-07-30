# OpenShift Deployment Guide

The Ambient Code Platform is an OpenShift-native platform that deploys an API server, frontend, and control plane into a managed namespace.

## Prerequisites

- OpenShift cluster with admin access
- Container registry access or use default images from quay.io/ambient_code
- `oc` CLI configured

## Quick Deploy

1. **Deploy** (from project root):
   ```bash
   # Choose an overlay (e.g., openshift-dev, production)
   oc apply -k components/manifests/overlays/<your-overlay>
   ```
   This deploys to the `ambient-code` namespace using default images from quay.io/ambient_code.

2. **Verify deployment**:
   ```bash
   oc get pods -n ambient-code
   oc get services -n ambient-code
   ```

3. **Access the UI**:
   ```bash
   # Get the route URL
   oc get route ambient-ui -n ambient-code

   # Or use port forwarding as fallback
   kubectl port-forward svc/ambient-ui-service 3000:3000 -n ambient-code
   ```

## Configuration

### Customizing Namespace
Set the namespace in your overlay's `kustomization.yaml`:
```yaml
namespace: my-namespace
```

### Building Custom Images
To build and use your own images:
```bash
# Set your container registry
export REGISTRY="quay.io/your-username"

# Login to your container registry
docker login $REGISTRY

# Build and push all images
make build-all REGISTRY=$REGISTRY
make push-all REGISTRY=$REGISTRY

# Update your overlay's kustomization.yaml images section, then deploy
oc apply -k components/manifests/overlays/<your-overlay>
```

### Advanced Configuration
Customize your deployment by editing overlay-specific patches and `kustomization.yaml` files under `components/manifests/overlays/<your-overlay>/`. See `components/manifests/env.example` for the list of configurable values.

### Gateway Trusted CA (Required for OIDC)

When gateways are configured with OIDC authentication (e.g., Keycloak), the gateway
pods must trust the CA that signed the OIDC issuer's TLS certificate. On OpenShift,
Routes use certificates signed by the cluster's ingress CA, which is not present in
the gateway's minimal container image.

The control plane looks for a ConfigMap named `gateway-trusted-ca` in the
`ambient-code` namespace. If found, it automatically copies the CA bundle to each
tenant namespace and mounts it into gateway pods via the `SSL_CERT_FILE` environment
variable.

**Without this ConfigMap, gateway OIDC will fail** with:
```
OIDC key refresh failed
JWKS fetch failed: error sending request for url (https://<keycloak-route>/...certs)
```

**Create the ConfigMap:**
```bash
# Extract the OpenShift ingress CA (signs *.apps.<cluster> Route certificates)
oc get configmap router-ca -n openshift-config-managed \
  -o jsonpath='{.data.ca-bundle\.crt}' > /tmp/ca-bundle.crt

# Create the ConfigMap the control plane expects
oc create configmap gateway-trusted-ca \
  --from-file=ca-bundle.crt=/tmp/ca-bundle.crt \
  -n ambient-code
```

The next gateway reconcile cycle will pick up the ConfigMap and roll out updated
gateway pods. To force an immediate update, delete the gateway pod in the tenant
namespace:
```bash
oc delete pod -l app.kubernetes.io/name=openshell -n <tenant-namespace>
```

**Verify it worked:**
```bash
# Confirm the CA is mounted
oc get pod -l app.kubernetes.io/name=openshell -n <tenant-namespace> -o json \
  | jq '.items[0].spec.containers[0].env[] | select(.name == "SSL_CERT_FILE")'

# Check gateway logs for successful OIDC
oc logs -l app.kubernetes.io/name=openshell -n <tenant-namespace> | grep -i oidc
```

> **Note:** If the cluster's ingress CA rotates, update the `gateway-trusted-ca`
> ConfigMap and restart the gateway pods.

### Sandbox SCC (Required on OpenShift)

When a namespace that will host gateway sandboxes is created on OpenShift, the
`openshell-sandbox` service account must be granted the `privileged` SCC. Without
this, sandbox pods will fail to start due to insufficient permissions.

```bash
oc adm policy add-scc-to-user privileged -z openshell-sandbox -n <namespace>
```

Run this once per tenant namespace. See the
[NVIDIA OpenShell docs](https://docs.nvidia.com/openshell/kubernetes/openshift#grant-the-privileged-scc-to-sandbox-pods)
for details.

### Setting up API Keys
After deployment, configure runner secrets through Settings → Runner Secrets in the UI. At minimum, provide `ANTHROPIC_API_KEY`.

### OpenShift OAuth (Legacy)
For cluster login via OAuth proxy sidecar, see [OpenShift OAuth Setup](OPENSHIFT_OAUTH.md).

For new deployments, SSO/OIDC via Keycloak is recommended instead. See `specs/security/sso-authentication.spec.md`.

## Troubleshooting

### Gateway OIDC: "OIDC key refresh failed"

**Symptom:** Control plane logs show `provisioning failed` with `OIDC key refresh failed` for sessions using gateway mode.

**Cause:** The gateway pod cannot verify the Keycloak Route's TLS certificate because the OpenShift ingress CA is not in the gateway container's trust store.

**Fix:** Create the `gateway-trusted-ca` ConfigMap — see [Gateway Trusted CA](#gateway-trusted-ca-required-for-oidc) above.

## Cleanup

```bash
# Uninstall resources
oc delete -k components/manifests/overlays/<your-overlay>
```
