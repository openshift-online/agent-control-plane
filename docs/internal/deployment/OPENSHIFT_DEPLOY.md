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

### Setting up API Keys
After deployment, configure runner secrets through Settings → Runner Secrets in the UI. At minimum, provide `ANTHROPIC_API_KEY`.

### OpenShift OAuth (Legacy)
For cluster login via OAuth proxy sidecar, see [OpenShift OAuth Setup](OPENSHIFT_OAUTH.md).

For new deployments, SSO/OIDC via Keycloak is recommended instead. See `specs/security/sso-authentication.spec.md`.

## Cleanup

```bash
# Uninstall resources
oc delete -k components/manifests/overlays/<your-overlay>
```
