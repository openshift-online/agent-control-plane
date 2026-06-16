# Deployment Documentation

Guides for deploying the Ambient Code Platform to various environments.

## Deployment Guides

### Production Deployment
- **[OpenShift Deployment](OPENSHIFT_DEPLOY.md)** - Deploy to production OpenShift cluster
- **[OAuth Configuration](OPENSHIFT_OAUTH.md)** - Set up OpenShift OAuth authentication (legacy; being replaced by SSO/OIDC)
- **SSO Migration** - Keycloak SSO/OIDC authentication (see `specs/security/sso-authentication.spec.md`)

### Configuration
- **[Git Authentication](git-authentication.md)** - Configure Git credentials for runners
- **[GitHub App Setup](../GITHUB_APP_SETUP.md)** - GitHub App integration

### Observability
- **[Langfuse Deployment](langfuse.md)** - LLM observability and tracing

### Storage
- **[S3 Storage Configuration](s3-storage-configuration.md)** - S3-compatible storage setup

## Deployment Checklist

### Prerequisites
- [ ] OpenShift or Kubernetes cluster with admin access
- [ ] Container registry access (or use default `quay.io/ambient_code`)
- [ ] `oc` or `kubectl` CLI configured
- [ ] Anthropic API key or Vertex AI credentials

### Basic Deployment

```bash
# 1. Choose an overlay (e.g., openshift-dev, production, kind)
# 2. Deploy
oc apply -k components/manifests/overlays/<your-overlay>

# 3. Verify
oc get pods -n ambient-code
oc get routes -n ambient-code
```

### Post-Deployment Configuration

1. **Configure Runner Secrets**:
   - Access web UI
   - Navigate to Settings → Runner Secrets
   - Add Anthropic API key

2. **Set Up Git Authentication** (optional):
   - See [Git Authentication Guide](git-authentication.md)
   - Configure per-project or use GitHub App

3. **Enable Observability** (optional):
   - Deploy Langfuse: [Langfuse Guide](langfuse.md)
   - Configure runner to send traces

## Deployment Options

### Using Default Images

Fastest deployment using pre-built images from `quay.io/ambient_code`:

```bash
oc apply -k components/manifests/overlays/<your-overlay>
```

### Building Custom Images

Build and deploy your own images:

```bash
# Build all images
make build-all CONTAINER_ENGINE=podman

# Push to registry
make push-all REGISTRY=quay.io/your-username

# Deploy with custom images (override in your overlay's kustomization.yaml images section)
```

### Custom Namespace

Set the namespace in your overlay's `kustomization.yaml`:

```yaml
namespace: my-namespace
```

## Security Configuration

### Authentication

**Production (Recommended):**
- SSO/OIDC via Keycloak (see `specs/security/sso-authentication.spec.md`)
- Namespace-scoped RBAC
- No shared credentials

**Production (Legacy):**
- OpenShift OAuth proxy sidecar (see [OAuth Configuration](OPENSHIFT_OAUTH.md))

**Local Development (Insecure):**
- Authentication disabled
- Mock tokens accepted
- See [Local Development](../developer/local-development/)

### RBAC

The platform uses namespace-scoped RBAC:
- Each project maps to a Kubernetes namespace
- Users need appropriate permissions in namespace
- API server uses user tokens (not service account)

See [ADR-0002: User Token Authentication](../adr/0002-user-token-authentication.md)

### Secrets Management

- **API Keys**: Stored in Kubernetes Secrets
- **Git Credentials**: Per-project secrets
- **OAuth Tokens**: Managed by OpenShift OAuth

## Monitoring & Observability

### Health Checks

```bash
# API server health
curl https://<api-server-route>/health

# Frontend accessibility
curl https://<frontend-route>/

# Control plane status
oc get pods -n ambient-code -l app=ambient-control-plane
```

### Logs

```bash
# API server logs
oc logs -n ambient-code deployment/ambient-api-server -f

# Frontend logs
oc logs -n ambient-code deployment/ambient-ui -f

# Control plane logs
oc logs -n ambient-code deployment/ambient-control-plane -f

# Runner job logs (in project namespaces)
oc logs -n <project-namespace> job/<job-name>
```

### Metrics

- Prometheus-compatible metrics (if configured)
- Langfuse for LLM observability
- OpenShift monitoring integration

## Cleanup

### Uninstall Platform

```bash
oc delete -k components/manifests/overlays/<your-overlay>
```

### Remove Namespace

```bash
oc delete namespace ambient-code
```

### Full Cleanup

```bash
# Remove the kustomize-deployed resources
oc delete -k components/manifests/overlays/<your-overlay>

# Remove cluster-level RBAC
oc delete clusterrole ambient-control-plane
oc delete clusterrolebinding ambient-control-plane
```

## Troubleshooting

### Pods Not Starting

```bash
# Check pod status
oc get pods -n ambient-code

# Describe pod for events
oc describe pod <pod-name> -n ambient-code

# View logs
oc logs <pod-name> -n ambient-code
```

### Image Pull Errors

```bash
# Check image pull secrets
oc get deployment ambient-api-server -n ambient-code -o jsonpath='{.spec.template.spec.imagePullSecrets}'

# Verify image exists
```

### Route Not Accessible

```bash
# Check route
oc get route ambient-ui -n ambient-code

# Check service
oc get svc ambient-ui-service -n ambient-code

# Test service directly
oc port-forward svc/ambient-ui-service 3000:3000 -n ambient-code
```

### Control Plane Not Creating Jobs

```bash
# Check control plane logs
oc logs -n ambient-code deployment/ambient-control-plane -f

# Verify control plane has permissions
oc get clusterrolebinding ambient-control-plane
```

## Related Documentation

- [Architecture Overview](../architecture/) - System design
- [Component Documentation](../../components/) - Component-specific guides
- [Local Development](../developer/local-development/) - Development environments
- [Testing](../testing/) - Test suite documentation

## Contributing

When adding deployment features:
- Update relevant deployment guide
- Test on both OpenShift and Kubernetes
- Document any new configuration options
- Update this index

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for full guidelines.
