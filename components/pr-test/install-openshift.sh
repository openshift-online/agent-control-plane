#!/usr/bin/env bash
# install-openshift.sh — deploy a fully self-contained ACP instance to OpenShift.
#
# Creates: namespace, PostgreSQL, Keycloak (with realm import), API server,
# control plane, UI, Routes, RBAC — everything needed for a working ACP
# instance with SSO authentication and Vertex AI inference.
#
# Usage:
#   bash install-openshift.sh <namespace> [image-sha]
#
# Environment variables:
#   REGISTRY             Image registry prefix (default: quay.io/ambient_code)
#   OC                   oc/kubectl binary (default: oc)
#   VERTEX_SA_KEY_FILE   Path to Vertex AI service account JSON key
#   VERTEX_PROJECT_ID    GCP project ID (default: auto-detected from key)
#   VERTEX_REGION        Vertex AI region (default: global)
#   SKIP_RBAC            Set to 1 to skip ClusterRole/ClusterRoleBinding creation
#   SKIP_KEYCLOAK        Set to 1 to skip Keycloak deployment (use existing IdP)
#   KEYCLOAK_REALM_URL   External Keycloak realm URL (required if SKIP_KEYCLOAK=1)
#   KC_DEV_PASSWORD      Password for 'developer' user (default: developer)
#   KC_ADMIN_PASSWORD    Password for 'admin' user (default: admin)
#   DRY_RUN              Set to 1 to print manifests without applying
set -euo pipefail

NAMESPACE="${1:-}"
IMAGE_SHA="${2:-}"
REGISTRY="${REGISTRY:-quay.io/ambient_code}"
CLI="${OC:-oc}"
SKIP_RBAC="${SKIP_RBAC:-}"
SKIP_KEYCLOAK="${SKIP_KEYCLOAK:-}"
DRY_RUN="${DRY_RUN:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

usage() {
  echo "Usage: $0 <namespace> [image-sha]"
  echo ""
  echo "  namespace:  Target namespace (will be created if it doesn't exist)"
  echo "  image-sha:  Git SHA for image tags (default: latest)"
  echo ""
  echo "Environment variables:"
  echo "  VERTEX_SA_KEY_FILE  Path to Vertex AI service account JSON key"
  echo "  VERTEX_PROJECT_ID   GCP project ID (auto-detected from key if not set)"
  echo "  VERTEX_REGION       Vertex AI region (default: global)"
  echo "  REGISTRY            Image registry prefix (default: quay.io/ambient_code)"
  echo "  OC                  oc binary (default: oc)"
  echo "  SKIP_RBAC           Set to 1 to skip ClusterRole/ClusterRoleBinding"
  echo "  SKIP_KEYCLOAK       Set to 1 to skip Keycloak (set KEYCLOAK_REALM_URL)"
  echo "  KC_DEV_PASSWORD     Password for 'developer' user (default: developer)"
  echo "  KC_ADMIN_PASSWORD   Password for 'admin' user (default: admin)"
  echo "  DRY_RUN             Set to 1 to print manifests only"
  exit 1
}

[[ -z "$NAMESPACE" ]] && usage

IMAGE_TAG="${IMAGE_SHA:-latest}"

log()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    \033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '    \033[33m⚠ %s\033[0m\n' "$*"; }
fail() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

apply() {
  if [[ "$DRY_RUN" == "1" ]]; then
    cat
  else
    $CLI apply -f -
  fi
}

apply_ns() {
  if [[ "$DRY_RUN" == "1" ]]; then
    cat
  else
    $CLI apply -n "$NAMESPACE" -f -
  fi
}

# ── preflight ────────────────────────────────────────────────────────────────

log "Preflight checks"

if ! command -v "$CLI" &>/dev/null; then
  fail "$CLI not found"
fi

if ! $CLI whoami &>/dev/null 2>&1; then
  fail "Not logged in to OpenShift. Run: oc login ..."
fi

CLUSTER_DOMAIN=$($CLI get ingresses.config.openshift.io cluster \
  -o jsonpath='{.spec.domain}' 2>/dev/null || true)
if [[ -z "$CLUSTER_DOMAIN" ]]; then
  warn "Could not detect cluster apps domain — routes will use auto-generated hostnames"
fi
info "Cluster: $($CLI whoami --show-server 2>/dev/null || echo unknown)"
info "User: $($CLI whoami 2>/dev/null || echo unknown)"
info "Apps domain: ${CLUSTER_DOMAIN:-<auto>}"
info "Namespace: $NAMESPACE"
info "Images: ${REGISTRY}/acp_*:${IMAGE_TAG}"

# ── Vertex AI credentials ────────────────────────────────────────────────────

VERTEX_SA_KEY_FILE="${VERTEX_SA_KEY_FILE:-}"
VERTEX_PROJECT_ID="${VERTEX_PROJECT_ID:-}"
VERTEX_REGION="${VERTEX_REGION:-global}"
VERTEX_KEY_FILENAME="vertex-sa-key.json"
USE_VERTEX=0

if [[ -n "$VERTEX_SA_KEY_FILE" ]]; then
  if [[ ! -f "$VERTEX_SA_KEY_FILE" ]]; then
    fail "VERTEX_SA_KEY_FILE does not exist: $VERTEX_SA_KEY_FILE"
  fi
  USE_VERTEX=1
  VERTEX_KEY_FILENAME=$(basename "$VERTEX_SA_KEY_FILE")
  if [[ -z "$VERTEX_PROJECT_ID" ]]; then
    VERTEX_PROJECT_ID=$(python3 -c "import json; print(json.load(open('$VERTEX_SA_KEY_FILE'))['project_id'])" 2>/dev/null || true)
    if [[ -z "$VERTEX_PROJECT_ID" ]]; then
      fail "Could not auto-detect VERTEX_PROJECT_ID from $VERTEX_SA_KEY_FILE"
    fi
  fi
  ok "Vertex AI: project=$VERTEX_PROJECT_ID region=$VERTEX_REGION"
else
  warn "No VERTEX_SA_KEY_FILE set — runners will need ANTHROPIC_API_KEY"
fi

# ── namespace ────────────────────────────────────────────────────────────────

log "Ensuring namespace $NAMESPACE"

if ! $CLI get namespace "$NAMESPACE" &>/dev/null 2>&1; then
  $CLI create namespace "$NAMESPACE"
  ok "Created namespace $NAMESPACE"
else
  ok "Namespace $NAMESPACE already exists"
fi

# ── secrets ──────────────────────────────────────────────────────────────────

log "Creating secrets"

EXISTING_DB_PASS=$($CLI get secret ambient-api-server-db -n "$NAMESPACE" \
  -o jsonpath='{.data.db\.password}' 2>/dev/null | base64 -d 2>/dev/null || true)
EXISTING_KC_SECRET=$($CLI get secret sso-credentials -n "$NAMESPACE" \
  -o jsonpath='{.data.SSO_CLIENT_SECRET}' 2>/dev/null | base64 -d 2>/dev/null || true)
EXISTING_OIDC_SECRET=$($CLI get secret ambient-control-plane-oidc -n "$NAMESPACE" \
  -o jsonpath='{.data.client-secret}' 2>/dev/null | base64 -d 2>/dev/null || true)
EXISTING_ENCRYPTION_KEY=$($CLI get secret credential-encryption-key -n "$NAMESPACE" \
  -o jsonpath='{.data.keyring}' 2>/dev/null | base64 -d 2>/dev/null || true)
EXISTING_ENCRYPTION_VER=$($CLI get secret credential-encryption-key -n "$NAMESPACE" \
  -o jsonpath='{.data.version}' 2>/dev/null | base64 -d 2>/dev/null || true)
EXISTING_SESSION_SECRET=$($CLI get secret sso-credentials -n "$NAMESPACE" \
  -o jsonpath='{.data.SESSION_SECRET}' 2>/dev/null | base64 -d 2>/dev/null || true)

DB_PASS="${EXISTING_DB_PASS:-$(python3 -c "import secrets; print(secrets.token_urlsafe(24))")}"
SESSION_SECRET="${EXISTING_SESSION_SECRET:-$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")}"
KC_CLIENT_SECRET="${EXISTING_KC_SECRET:-acp-$(python3 -c "import secrets; print(secrets.token_urlsafe(16))")}"
OIDC_CLIENT_SECRET="${EXISTING_OIDC_SECRET:-cp-$(python3 -c "import secrets; print(secrets.token_urlsafe(16))")}"
if [[ -n "$EXISTING_ENCRYPTION_KEY" ]]; then
  ENCRYPTION_KEYRING="$EXISTING_ENCRYPTION_KEY"
  ENCRYPTION_VER="$EXISTING_ENCRYPTION_VER"
else
  RAW_KEY="$(openssl rand -base64 32 2>/dev/null || python3 -c "import secrets,base64; print(base64.b64encode(secrets.token_bytes(32)).decode())")"
  ENCRYPTION_KEYRING="{\"1\":\"$RAW_KEY\"}"
  ENCRYPTION_VER="1"
fi

$CLI create secret generic ambient-api-server-db -n "$NAMESPACE" \
  --from-literal=db.host=ambient-api-server-db \
  --from-literal=db.port=5432 \
  --from-literal=db.user=ambient \
  --from-literal="db.password=$DB_PASS" \
  --from-literal=db.name=ambient_api_server \
  --from-literal=db.ca_cert="" \
  --dry-run=client -o yaml | $CLI apply -f -
ok "Reconciled ambient-api-server-db secret"

$CLI create secret generic ambient-api-server -n "$NAMESPACE" \
  --from-literal=clientId=ambient-control-plane \
  --from-literal=clientSecret="$OIDC_CLIENT_SECRET" \
  --dry-run=client -o yaml | $CLI apply -f -
ok "Reconciled ambient-api-server secret"

$CLI create secret generic ambient-control-plane-oidc -n "$NAMESPACE" \
  --from-literal=client-id=ambient-control-plane \
  --from-literal=client-secret="$OIDC_CLIENT_SECRET" \
  --dry-run=client -o yaml | $CLI apply -f -
ok "Reconciled ambient-control-plane-oidc secret"

$CLI create secret generic credential-encryption-key -n "$NAMESPACE" \
  --from-literal=keyring="$ENCRYPTION_KEYRING" \
  --from-literal=version="$ENCRYPTION_VER" \
  --dry-run=client -o yaml | $CLI apply -f -
ok "Reconciled credential-encryption-key secret"

if [[ "$USE_VERTEX" == "1" ]]; then
  $CLI create secret generic ambient-vertex -n "$NAMESPACE" \
    --from-file="$VERTEX_KEY_FILENAME=$VERTEX_SA_KEY_FILE" \
    --dry-run=client -o yaml | $CLI apply -f -
  ok "Reconciled ambient-vertex secret"
fi

# ── ServiceAccount + RBAC ────────────────────────────────────────────────────

log "Creating ServiceAccounts and RBAC"

SA_NAME="ambient-control-plane"
CR_NAME="ambient-control-plane-${NAMESPACE}"

$CLI apply -n "$NAMESPACE" -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${SA_NAME}
  namespace: ${NAMESPACE}
  labels:
    app: ambient-control-plane
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ambient-api-server
  namespace: ${NAMESPACE}
  labels:
    app: ambient-api-server
EOF

if ! $CLI get secret ambient-control-plane-token -n "$NAMESPACE" &>/dev/null; then
  $CLI apply -n "$NAMESPACE" -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: ambient-control-plane-token
  namespace: ${NAMESPACE}
  annotations:
    kubernetes.io/service-account.name: ${SA_NAME}
  labels:
    app: ambient-control-plane
type: kubernetes.io/service-account-token
EOF
  ok "Created SA token secret"
else
  ok "SA token secret exists"
fi

if [[ "$SKIP_RBAC" != "1" ]]; then
  apply <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ${CR_NAME}
rules:
- apiGroups: [""]
  resources: ["namespaces"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
- apiGroups: ["rbac.authorization.k8s.io"]
  resources: ["roles", "rolebindings", "clusterroles", "clusterrolebindings"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete", "escalate", "bind"]
- apiGroups: [""]
  resources: ["secrets", "serviceaccounts", "services", "pods", "pods/log", "pods/exec", "configmaps", "events"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete", "deletecollection"]
- apiGroups: ["batch"]
  resources: ["jobs"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["networking.k8s.io"]
  resources: ["networkpolicies"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["get", "list"]
- apiGroups: ["authentication.k8s.io"]
  resources: ["tokenreviews"]
  verbs: ["create"]
- apiGroups: ["agents.x-k8s.io"]
  resources: ["sandboxes", "sandboxes/status", "sandboxes/exec"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["route.openshift.io"]
  resources: ["routes"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["namespaces/finalizers", "pods/finalizers", "secrets/finalizers", "serviceaccounts/finalizers", "configmaps/finalizers"]
  verbs: ["update"]
- apiGroups: ["batch"]
  resources: ["jobs/finalizers"]
  verbs: ["update"]
- apiGroups: ["rbac.authorization.k8s.io"]
  resources: ["roles/finalizers", "rolebindings/finalizers"]
  verbs: ["update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${CR_NAME}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ${CR_NAME}
subjects:
- kind: ServiceAccount
  name: ${SA_NAME}
  namespace: ${NAMESPACE}
EOF
  ok "Created ClusterRole and ClusterRoleBinding: ${CR_NAME}"
else
  info "Skipping RBAC (SKIP_RBAC=1)"
fi

# ── PostgreSQL ───────────────────────────────────────────────────────────────

log "Deploying PostgreSQL"

apply_ns <<EOF
apiVersion: v1
kind: Service
metadata:
  name: ambient-api-server-db
  labels:
    app: ambient-api-server
    component: database
spec:
  ports:
  - name: postgresql
    port: 5432
    protocol: TCP
    targetPort: 5432
  selector:
    app: ambient-api-server
    component: database
  type: ClusterIP
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ambient-api-server-db
  labels:
    app: ambient-api-server
    component: database
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ambient-api-server
      component: database
  strategy:
    type: Recreate
  template:
    metadata:
      labels:
        app: ambient-api-server
        component: database
    spec:
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: postgresql
        image: registry.redhat.io/rhel9/postgresql-16:latest
        ports:
        - containerPort: 5432
          name: postgresql
        env:
        - name: POSTGRESQL_USER
          valueFrom:
            secretKeyRef:
              key: db.user
              name: ambient-api-server-db
        - name: POSTGRESQL_PASSWORD
          valueFrom:
            secretKeyRef:
              key: db.password
              name: ambient-api-server-db
        - name: POSTGRESQL_DATABASE
          valueFrom:
            secretKeyRef:
              key: db.name
              name: ambient-api-server-db
        volumeMounts:
        - name: data
          mountPath: /var/lib/pgsql/data
          subPath: pgdata
        readinessProbe:
          exec:
            command: ["/bin/sh", "-c", "pg_isready -U \"\$POSTGRESQL_USER\""]
          initialDelaySeconds: 10
          periodSeconds: 10
        livenessProbe:
          exec:
            command: ["/bin/sh", "-c", "pg_isready -U \"\$POSTGRESQL_USER\""]
          initialDelaySeconds: 30
          periodSeconds: 30
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
      volumes:
      - name: data
        emptyDir: {}
EOF

info "Waiting for PostgreSQL..."
$CLI rollout status deployment/ambient-api-server-db -n "$NAMESPACE" --timeout=120s
for i in $(seq 1 30); do
  if $CLI exec -n "$NAMESPACE" deploy/ambient-api-server-db -- \
    /bin/sh -c 'pg_isready -U "$POSTGRESQL_USER"' &>/dev/null; then
    ok "PostgreSQL is accepting connections"
    break
  fi
  [[ $i -eq 30 ]] && fail "PostgreSQL did not become ready"
  sleep 2
done

# ── Keycloak ─────────────────────────────────────────────────────────────────

if [[ "$SKIP_KEYCLOAK" != "1" ]]; then
  log "Deploying Keycloak"

  KC_ROUTE_HOST=""
  if [[ -n "$CLUSTER_DOMAIN" ]]; then
    KC_ROUTE_HOST="keycloak-${NAMESPACE}.${CLUSTER_DOMAIN}"
  fi
  KC_EXTERNAL_URL="https://${KC_ROUTE_HOST}"
  KEYCLOAK_REALM_URL="${KC_EXTERNAL_URL}/realms/ambient-code"

  UI_ROUTE_HOST=""
  if [[ -n "$CLUSTER_DOMAIN" ]]; then
    UI_ROUTE_HOST="ambient-ui-${NAMESPACE}.${CLUSTER_DOMAIN}"
  fi

  REALM_JSON=$(cat "$REPO_ROOT/components/manifests/overlays/kind/keycloak-realm.json" | \
    python3 -c "
import json, sys
realm = json.load(sys.stdin)
realm['sslRequired'] = 'none'
ns = '$NAMESPACE'
kc_host = '${KC_ROUTE_HOST}'
ui_host = '${UI_ROUTE_HOST}'
kc_secret = '${KC_CLIENT_SECRET}'
oidc_secret = '${OIDC_CLIENT_SECRET}'
dev_password = '${KC_DEV_PASSWORD:-developer}'
admin_password = '${KC_ADMIN_PASSWORD:-admin}'
for user in realm.get('users', []):
    if user['username'] == 'developer':
        user['credentials'] = [{'type': 'password', 'value': dev_password, 'temporary': False}]
    elif user['username'] == 'admin':
        user['credentials'] = [{'type': 'password', 'value': admin_password, 'temporary': False}]
for client in realm.get('clients', []):
    if client['clientId'] == 'ambient-frontend':
        client['secret'] = kc_secret
        client['redirectUris'] = [
            'https://' + ui_host + '/*',
            'http://localhost/*',
            'http://127.0.0.1/*',
        ]
        client['attributes']['post.logout.redirect.uris'] = 'https://' + ui_host + '/*'
        client['webOrigins'] = ['+']
    elif client['clientId'] == 'ambient-cli':
        client['redirectUris'] = ['http://localhost/*', 'http://127.0.0.1/*']
realm['clients'].append({
    'clientId': 'ambient-control-plane',
    'enabled': True,
    'protocol': 'openid-connect',
    'publicClient': False,
    'secret': oidc_secret,
    'serviceAccountsEnabled': True,
    'standardFlowEnabled': False,
    'directAccessGrantsEnabled': True,
    'fullScopeAllowed': True,
    'defaultClientScopes': ['openid', 'email', 'profile'],
})
json.dump(realm, sys.stdout, indent=2)
")

  apply_ns <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: keycloak-realm-config
data:
  ambient-code-realm.json: |
$(echo "$REALM_JSON" | sed 's/^/    /')
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: keycloak
  labels:
    app: keycloak
spec:
  replicas: 1
  selector:
    matchLabels:
      app: keycloak
  template:
    metadata:
      labels:
        app: keycloak
    spec:
      securityContext:
        runAsNonRoot: false
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: keycloak
        image: quay.io/keycloak/keycloak:26.0.7
        args: ["start-dev", "--import-realm"]
        env:
        - name: KEYCLOAK_ADMIN
          value: admin
        - name: KEYCLOAK_ADMIN_PASSWORD
          value: "${KC_ADMIN_PASSWORD:-admin}"
        - name: KC_HOSTNAME
          value: "${KC_EXTERNAL_URL}"
        - name: KC_HOSTNAME_BACKCHANNEL_DYNAMIC
          value: "true"
        - name: KC_PROXY_HEADERS
          value: "xforwarded"
        - name: KC_HTTP_ENABLED
          value: "true"
        - name: KC_HEALTH_ENABLED
          value: "true"
        ports:
        - name: http
          containerPort: 8080
          protocol: TCP
        volumeMounts:
        - name: realm
          mountPath: /opt/keycloak/data/import
          readOnly: true
        readinessProbe:
          httpGet:
            path: /realms/ambient-code
            port: 8080
            scheme: HTTP
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 10
        livenessProbe:
          httpGet:
            path: /realms/ambient-code
            port: 8080
            scheme: HTTP
          initialDelaySeconds: 120
          periodSeconds: 30
          timeoutSeconds: 5
          failureThreshold: 5
        resources:
          requests:
            cpu: 200m
            memory: 768Mi
          limits:
            cpu: "2"
            memory: 2Gi
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
      volumes:
      - name: realm
        configMap:
          name: keycloak-realm-config
---
apiVersion: v1
kind: Service
metadata:
  name: keycloak-service
  labels:
    app: keycloak
spec:
  selector:
    app: keycloak
  ports:
  - name: http
    port: 8080
    targetPort: 8080
    protocol: TCP
  type: ClusterIP
---
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: keycloak
  labels:
    app: keycloak
spec:
  host: ${KC_ROUTE_HOST}
  to:
    kind: Service
    name: keycloak-service
  port:
    targetPort: http
  tls:
    termination: edge
    insecureEdgeTerminationPolicy: Redirect
EOF

  info "Waiting for Keycloak..."
  $CLI rollout status deployment/keycloak -n "$NAMESPACE" --timeout=300s
  ok "Keycloak deployed at ${KC_EXTERNAL_URL}"
else
  if [[ -z "${KEYCLOAK_REALM_URL:-}" ]]; then
    fail "SKIP_KEYCLOAK=1 requires KEYCLOAK_REALM_URL to be set"
  fi
  info "Using external Keycloak: ${KEYCLOAK_REALM_URL}"
fi

# ── SSO credentials secret ───────────────────────────────────────────────────

log "Creating SSO credentials"

SSO_ISSUER_URL="${KEYCLOAK_REALM_URL}"
SSO_FRONTEND_ISSUER_URL="${KEYCLOAK_REALM_URL}"
SSO_REDIRECT_URI="https://${UI_ROUTE_HOST:-ambient-ui-${NAMESPACE}.${CLUSTER_DOMAIN:-apps.local}}/api/auth/sso/callback"

$CLI create secret generic sso-credentials -n "$NAMESPACE" \
  --from-literal=SSO_ISSUER_URL="$SSO_ISSUER_URL" \
  --from-literal=SSO_FRONTEND_ISSUER_URL="$SSO_FRONTEND_ISSUER_URL" \
  --from-literal=SSO_CLIENT_ID=ambient-frontend \
  --from-literal=SSO_CLIENT_SECRET="$KC_CLIENT_SECRET" \
  --from-literal=SSO_AUDIENCE=ambient-frontend \
  --from-literal=SESSION_SECRET="$SESSION_SECRET" \
  --from-literal=SSO_REDIRECT_URI="$SSO_REDIRECT_URI" \
  --dry-run=client -o yaml | $CLI apply -f -
ok "Reconciled sso-credentials secret"

# ── Auth ConfigMap (JWKS from Keycloak) ──────────────────────────────────────

log "Creating auth ConfigMap"

JWKS_URL="${KEYCLOAK_REALM_URL}/protocol/openid-connect/certs"

apply_ns <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: ambient-api-server-auth
  labels:
    app: ambient-api-server
    component: auth
data:
  jwks.json: '{"keys":[]}'
  acl.yml: |
    - claim: email
      pattern: ^.*$
EOF
ok "Created ambient-api-server-auth ConfigMap"

# ── API Server ───────────────────────────────────────────────────────────────

log "Deploying API Server"

apply_ns <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ambient-api-server
  labels:
    app: ambient-api-server
    component: api
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ambient-api-server
      component: api
  template:
    metadata:
      labels:
        app: ambient-api-server
        component: api
    spec:
      serviceAccountName: ambient-api-server
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      initContainers:
      - name: migration
        image: ${REGISTRY}/acp_api_server:${IMAGE_TAG}
        imagePullPolicy: Always
        command:
        - /usr/local/bin/ambient-api-server
        - migrate
        - --db-host-file=/secrets/db/db.host
        - --db-port-file=/secrets/db/db.port
        - --db-user-file=/secrets/db/db.user
        - --db-password-file=/secrets/db/db.password
        - --db-name-file=/secrets/db/db.name
        - --db-sslmode=disable
        - --alsologtostderr
        - -v=4
        volumeMounts:
        - name: db-secrets
          mountPath: /secrets/db
        resources:
          requests:
            cpu: 50m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
      containers:
      - name: api-server
        image: ${REGISTRY}/acp_api_server:${IMAGE_TAG}
        imagePullPolicy: Always
        command:
        - /usr/local/bin/ambient-api-server
        - serve
        - --db-host-file=/secrets/db/db.host
        - --db-port-file=/secrets/db/db.port
        - --db-user-file=/secrets/db/db.user
        - --db-password-file=/secrets/db/db.password
        - --db-name-file=/secrets/db/db.name
        - --db-sslmode=disable
        - --enable-jwt=true
        - --enable-authz=true
        - --jwk-cert-url=${JWKS_URL}
        - --jwk-cert-file=/configs/authentication/jwks.json
        - --enable-https=false
        - --enable-grpc=true
        - --api-server-bindaddress=:8000
        - --metrics-server-bindaddress=:4433
        - --health-check-server-bindaddress=:4434
        - --db-max-open-connections=50
        - --enable-db-debug=false
        - --enable-metrics-https=false
        - --http-read-timeout=5s
        - --http-write-timeout=30s
        - --cors-allowed-origins=*
        - --cors-allowed-headers=X-Ambient-Project
        - --grpc-server-bindaddress=:9000
        - --grpc-enable-tls=false
        - --alsologtostderr
        - -v=4
        env:
        - name: AMBIENT_ENV
          value: production
        - name: GRPC_SERVICE_ACCOUNT
          valueFrom:
            secretKeyRef:
              name: ambient-control-plane-oidc
              key: client-id
        - name: CREDENTIAL_ENCRYPTION_KEYRING
          valueFrom:
            secretKeyRef:
              name: credential-encryption-key
              key: keyring
              optional: true
        - name: CREDENTIAL_ENCRYPTION_KEY_VERSION
          valueFrom:
            secretKeyRef:
              name: credential-encryption-key
              key: version
              optional: true
        - name: CREDENTIAL_ENCRYPTION_ALLOW_PLAINTEXT
          value: "true"
        ports:
        - name: api
          containerPort: 8000
          protocol: TCP
        - name: grpc
          containerPort: 9000
          protocol: TCP
        - name: metrics
          containerPort: 4433
          protocol: TCP
        - name: health
          containerPort: 4434
          protocol: TCP
        volumeMounts:
        - name: db-secrets
          mountPath: /secrets/db
        - name: app-secrets
          mountPath: /secrets/service
        - name: auth-config
          mountPath: /configs/authentication
        resources:
          requests:
            cpu: 200m
            memory: 512Mi
          limits:
            cpu: "1"
            memory: 1Gi
        livenessProbe:
          httpGet:
            path: /api/ambient
            port: 8000
            scheme: HTTP
          initialDelaySeconds: 15
          periodSeconds: 5
        readinessProbe:
          httpGet:
            path: /healthcheck
            port: 4434
            scheme: HTTP
            httpHeaders:
            - name: User-Agent
              value: Probe
          initialDelaySeconds: 20
          periodSeconds: 10
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
      volumes:
      - name: db-secrets
        secret:
          secretName: ambient-api-server-db
      - name: app-secrets
        secret:
          secretName: ambient-api-server
      - name: auth-config
        configMap:
          name: ambient-api-server-auth
---
apiVersion: v1
kind: Service
metadata:
  name: ambient-api-server
  labels:
    app: ambient-api-server
    component: api
spec:
  selector:
    app: ambient-api-server
    component: api
  ports:
  - name: api
    port: 8000
    targetPort: 8000
    protocol: TCP
  - name: grpc
    port: 9000
    targetPort: 9000
    protocol: TCP
  - name: metrics
    port: 4433
    targetPort: 4433
    protocol: TCP
  - name: health
    port: 4434
    targetPort: 4434
    protocol: TCP
EOF

# ── Control Plane ────────────────────────────────────────────────────────────

log "Deploying Control Plane"

OIDC_TOKEN_URL="${KEYCLOAK_REALM_URL}/protocol/openid-connect/token"

apply_ns <<EOF
apiVersion: v1
kind: Service
metadata:
  name: ambient-control-plane
  labels:
    app: ambient-control-plane
spec:
  selector:
    app: ambient-control-plane
  ports:
  - name: token
    port: 8080
    targetPort: 8080
    protocol: TCP
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ambient-control-plane
  labels:
    app: ambient-control-plane
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ambient-control-plane
  template:
    metadata:
      labels:
        app: ambient-control-plane
    spec:
      serviceAccountName: ${SA_NAME}
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: ambient-control-plane
        image: ${REGISTRY}/acp_control_plane:${IMAGE_TAG}
        imagePullPolicy: Always
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: ["ALL"]
        env:
        - name: AMBIENT_API_TOKEN
          valueFrom:
            secretKeyRef:
              name: ambient-control-plane-token
              key: token
              optional: true
        - name: AMBIENT_API_SERVER_URL
          value: "http://ambient-api-server.${NAMESPACE}.svc:8000"
        - name: AMBIENT_GRPC_SERVER_ADDR
          value: "ambient-api-server.${NAMESPACE}.svc:9000"
        - name: AMBIENT_GRPC_USE_TLS
          value: "false"
        - name: MODE
          value: "kube"
        - name: PLATFORM_MODE
          value: "standard"
        - name: LOG_LEVEL
          value: "info"
        - name: OIDC_TOKEN_URL
          value: "${OIDC_TOKEN_URL}"
        - name: OIDC_CLIENT_ID
          valueFrom:
            secretKeyRef:
              name: ambient-control-plane-oidc
              key: client-id
        - name: OIDC_CLIENT_SECRET
          valueFrom:
            secretKeyRef:
              name: ambient-control-plane-oidc
              key: client-secret
        - name: RUNNER_IMAGE
          value: "${REGISTRY}/acp_claude_runner:${IMAGE_TAG}"
        - name: MCP_IMAGE
          value: "${REGISTRY}/acp_mcp:${IMAGE_TAG}"
        - name: GITHUB_MCP_IMAGE
          value: "${REGISTRY}/acp_credential_github:${IMAGE_TAG}"
        - name: JIRA_MCP_IMAGE
          value: "${REGISTRY}/acp_credential_jira:${IMAGE_TAG}"
        - name: K8S_MCP_IMAGE
          value: "${REGISTRY}/acp_credential_k8s:${IMAGE_TAG}"
        - name: GOOGLE_MCP_IMAGE
          value: "${REGISTRY}/acp_credential_google:${IMAGE_TAG}"
        - name: MCP_API_SERVER_URL
          value: "http://ambient-api-server.${NAMESPACE}.svc:8000"
        - name: CP_TOKEN_URL
          value: "http://ambient-control-plane.${NAMESPACE}.svc:8080/token"
        - name: CP_RUNTIME_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: USE_VERTEX
          value: "${USE_VERTEX}"
        - name: ANTHROPIC_API_KEY
          valueFrom:
            secretKeyRef:
              name: ambient-anthropic
              key: api-key
              optional: true
        - name: ANTHROPIC_VERTEX_PROJECT_ID
          value: "${VERTEX_PROJECT_ID:-}"
        - name: CLOUD_ML_REGION
          value: "${VERTEX_REGION}"
        - name: GOOGLE_APPLICATION_CREDENTIALS
          value: "/app/vertex/${VERTEX_KEY_FILENAME}"
        - name: VERTEX_SECRET_NAME
          value: "ambient-vertex"
        - name: VERTEX_SECRET_NAMESPACE
          value: "${NAMESPACE}"
        - name: OPENSHELL_USE_GATEWAY
          value: "false"
        - name: OPENSHELL_ENABLED
          value: "false"
        volumeMounts:
        - name: vertex-credentials
          mountPath: /app/vertex
          readOnly: true
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 200m
            memory: 256Mi
      volumes:
      - name: vertex-credentials
        secret:
          secretName: ambient-vertex
          optional: true
          defaultMode: 420
EOF

# ── UI ───────────────────────────────────────────────────────────────────────

log "Deploying UI"

apply_ns <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ambient-ui
  labels:
    app: ambient-ui
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ambient-ui
  template:
    metadata:
      labels:
        app: ambient-ui
    spec:
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: ambient-ui
        image: ${REGISTRY}/acp_ambient_ui:${IMAGE_TAG}
        imagePullPolicy: Always
        env:
        - name: NODE_ENV
          value: production
        - name: API_SERVER_URL
          value: "http://ambient-api-server:8000"
        - name: SSO_ISSUER_URL
          valueFrom:
            secretKeyRef:
              name: sso-credentials
              key: SSO_ISSUER_URL
        - name: SSO_FRONTEND_ISSUER_URL
          valueFrom:
            secretKeyRef:
              name: sso-credentials
              key: SSO_FRONTEND_ISSUER_URL
              optional: true
        - name: SSO_CLIENT_ID
          valueFrom:
            secretKeyRef:
              name: sso-credentials
              key: SSO_CLIENT_ID
        - name: SSO_CLIENT_SECRET
          valueFrom:
            secretKeyRef:
              name: sso-credentials
              key: SSO_CLIENT_SECRET
        - name: SSO_AUDIENCE
          valueFrom:
            secretKeyRef:
              name: sso-credentials
              key: SSO_AUDIENCE
              optional: true
        - name: SESSION_SECRET
          valueFrom:
            secretKeyRef:
              name: sso-credentials
              key: SESSION_SECRET
        - name: SSO_REDIRECT_URI
          valueFrom:
            secretKeyRef:
              name: sso-credentials
              key: SSO_REDIRECT_URI
              optional: true
        - name: CONTROL_PLANE_URL
          value: "http://ambient-control-plane:8080"
        ports:
        - name: http
          containerPort: 3000
          protocol: TCP
        volumeMounts:
        - name: next-cache
          mountPath: /app/.next/cache
        - name: tmp
          mountPath: /tmp
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi
        livenessProbe:
          httpGet:
            path: /api/healthz
            port: 3000
            scheme: HTTP
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /api/healthz
            port: 3000
            scheme: HTTP
          initialDelaySeconds: 5
          periodSeconds: 5
        securityContext:
          readOnlyRootFilesystem: true
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
      volumes:
      - name: next-cache
        emptyDir: {}
      - name: tmp
        emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: ambient-ui-service
  labels:
    app: ambient-ui
spec:
  selector:
    app: ambient-ui
  ports:
  - name: http
    port: 3000
    targetPort: 3000
    protocol: TCP
EOF

# ── Routes ───────────────────────────────────────────────────────────────────

log "Creating Routes"

API_ROUTE_HOST=""
[[ -n "$CLUSTER_DOMAIN" ]] && API_ROUTE_HOST="ambient-api-${NAMESPACE}.${CLUSTER_DOMAIN}"

apply_ns <<EOF
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: ambient-api-server
  labels:
    app: ambient-api-server
  annotations:
    haproxy.router.openshift.io/timeout: 10m
spec:
  host: ${API_ROUTE_HOST}
  to:
    kind: Service
    name: ambient-api-server
  port:
    targetPort: api
  tls:
    termination: edge
    insecureEdgeTerminationPolicy: Redirect
---
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: ambient-ui
  labels:
    app: ambient-ui
spec:
  host: ${UI_ROUTE_HOST:-}
  to:
    kind: Service
    name: ambient-ui-service
  port:
    targetPort: http
  tls:
    termination: edge
    insecureEdgeTerminationPolicy: Redirect
EOF

# ── Wait for rollouts ────────────────────────────────────────────────────────

log "Waiting for rollouts"

for deploy in ambient-api-server ambient-control-plane ambient-ui; do
  info "Waiting for $deploy..."
  $CLI rollout status deployment/"$deploy" -n "$NAMESPACE" --timeout=300s
done
ok "All deployments ready"

# ── Verify ───────────────────────────────────────────────────────────────────

log "Verifying installation"

API_HOST=$($CLI get route ambient-api-server -n "$NAMESPACE" -o jsonpath='{.spec.host}' 2>/dev/null || true)
UI_HOST=$($CLI get route ambient-ui -n "$NAMESPACE" -o jsonpath='{.spec.host}' 2>/dev/null || true)
KC_HOST=$($CLI get route keycloak -n "$NAMESPACE" -o jsonpath='{.spec.host}' 2>/dev/null || true)

if [[ -n "$API_HOST" ]]; then
  HEALTH=$(curl -fsSk --connect-timeout 5 --max-time 20 \
    --retry 3 --retry-all-errors "https://${API_HOST}/api/ambient" 2>&1 || true)
  info "API health: ${HEALTH:-<no response>}"
fi

$CLI get pods -n "$NAMESPACE"

echo ""
log "Installation complete"
echo ""
echo "  Namespace:      $NAMESPACE"
echo "  API Server:     https://${API_HOST:-<pending>}"
echo "  UI:             https://${UI_HOST:-<pending>}"
echo "  Keycloak:       https://${KC_HOST:-<external>}"
echo "  Image Tag:      $IMAGE_TAG"
echo ""
echo "  Seeded Users:"
echo "    developer / developer  (ambient-users group)"
echo "    admin     / admin      (ambient-users + ambient-admins groups)"
echo ""
echo "  Quick start (developer):"
echo "    acpctl login --password-grant \\"
echo "      --username developer --password developer \\"
echo "      --issuer-url https://${KC_HOST:-keycloak}/realms/ambient-code \\"
echo "      --url https://${API_HOST} --insecure-skip-tls-verify"
echo ""
echo "  Quick start (admin):"
echo "    acpctl login --password-grant \\"
echo "      --username admin --password admin \\"
echo "      --issuer-url https://${KC_HOST:-keycloak}/realms/ambient-code \\"
echo "      --url https://${API_HOST} --insecure-skip-tls-verify"
echo ""
echo "  Browser login (OAuth2 auth-code flow):"
echo "    acpctl login --use-auth-code \\"
echo "      --issuer-url https://${KC_HOST:-keycloak}/realms/ambient-code \\"
echo "      --url https://${API_HOST} --insecure-skip-tls-verify"
echo ""
echo "  E2E Smoke Test:"
echo "    bash components/pr-test/e2e-smoke.sh $NAMESPACE"
echo ""
echo "  Teardown:"
echo "    bash components/pr-test/teardown-openshift.sh $NAMESPACE"
echo ""
