#!/bin/bash
set -euo pipefail

echo "Waiting for all deployments to be ready..."
echo ""

# Wait for PostgreSQL first so the API server can connect on startup
echo "⏳ Waiting for postgresql..."
kubectl wait --for=condition=available --timeout=300s \
  deployment/postgresql \
  -n ambient-code

# Restart the API server pod to break out of CrashLoopBackOff
echo "⏳ Restarting ambient-api-server (DB is now ready)..."
kubectl delete pod -l app=ambient-api-server -n ambient-code --wait=false 2>/dev/null || true

# Wait for ambient-api-server
echo "⏳ Waiting for ambient-api-server..."
kubectl wait --for=condition=available --timeout=300s \
  deployment/ambient-api-server \
  -n ambient-code

# Wait for ambient-control-plane
echo "⏳ Waiting for ambient-control-plane..."
kubectl wait --for=condition=available --timeout=300s \
  deployment/ambient-control-plane \
  -n ambient-code

# Wait for ambient-ui
echo "⏳ Waiting for ambient-ui..."
kubectl wait --for=condition=available --timeout=300s \
  deployment/ambient-ui \
  -n ambient-code

# Wait for MinIO (required for session state persistence)
echo "⏳ Waiting for minio..."
kubectl wait --for=condition=available --timeout=300s \
  deployment/minio \
  -n ambient-code 2>/dev/null || echo "⚠️  MinIO not deployed (S3 persistence disabled)"

# Wait for Keycloak (SSO/OIDC provider)
echo "⏳ Waiting for keycloak..."
kubectl wait --for=condition=available --timeout=300s \
  deployment/keycloak \
  -n ambient-code 2>/dev/null || echo "⚠️  Keycloak not deployed (SSO disabled)"

echo ""
echo "✅ All pods are ready!"
echo ""

# Show pod status
kubectl get pods -n ambient-code
