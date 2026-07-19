#!/usr/bin/env bash
# seed-data.sh — seed application data into a fresh ACP instance.
#
# Seeds users, RBAC, projects, credentials, providers, gateways, policies,
# and agents from examples/overlays/ so that every example is proven to work.
#
# Runs after install-openshift.sh, before e2e-smoke.sh.
# Idempotent — safe to re-run.
#
# Usage:
#   bash seed-data.sh <namespace>
#
# Environment variables:
#   OC                   oc/kubectl binary (default: oc)
#   VERTEX_SA_KEY_FILE   Path to Vertex AI service account JSON key
#   GITHUB_TOKEN         GitHub Personal Access Token
#   JIRA_TOKEN           Jira API token
#   JIRA_EMAIL           Jira user email (default: developer@local.dev)
set -euo pipefail

NAMESPACE="${1:-}"
CLI="${OC:-oc}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

usage() {
  echo "Usage: $0 <namespace>"
  echo ""
  echo "Environment variables:"
  echo "  VERTEX_SA_KEY_FILE  Path to Vertex AI service account JSON key"
  echo "  GITHUB_TOKEN        GitHub Personal Access Token"
  echo "  JIRA_TOKEN          Jira API token"
  echo "  JIRA_EMAIL          Jira user email (default: developer@local.dev)"
  echo "  OC                  oc binary (default: oc)"
  exit 1
}

[[ -z "$NAMESPACE" ]] && usage

log()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    \033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '    \033[33m⚠ %s\033[0m\n' "$*"; }
fail() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ── preflight ────────────────────────────────────────────────────────────────

log "Preflight checks"

if ! command -v "$CLI" &>/dev/null; then
  fail "$CLI not found"
fi

if ! command -v python3 &>/dev/null; then
  fail "python3 is required"
fi

python3 -c "import yaml" 2>/dev/null || fail "pyyaml is required: pip install pyyaml"

DB_POD=$($CLI get pods -n "$NAMESPACE" -l "component=database,app=ambient-api-server" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
[[ -z "$DB_POD" ]] && fail "Database pod not found in $NAMESPACE"

DB_USER=$($CLI get secret ambient-api-server-db -n "$NAMESPACE" \
  -o jsonpath='{.data.db\.user}' 2>/dev/null | base64 -d 2>/dev/null || true)
DB_NAME=$($CLI get secret ambient-api-server-db -n "$NAMESPACE" \
  -o jsonpath='{.data.db\.name}' 2>/dev/null | base64 -d 2>/dev/null || true)

[[ -z "$DB_USER" ]] && fail "Could not read db.user from ambient-api-server-db secret"
[[ -z "$DB_NAME" ]] && fail "Could not read db.name from ambient-api-server-db secret"

ok "Database pod: $DB_POD"
ok "Database: $DB_NAME (user: $DB_USER)"

VERTEX_SA_KEY_FILE="${VERTEX_SA_KEY_FILE:-}"
GITHUB_TOKEN=${GITHUB_TOKEN:-}  # notsecret: reads from env
JIRA_TOKEN=${JIRA_TOKEN:-}  # notsecret: reads from env
JIRA_EMAIL="${JIRA_EMAIL:-developer@local.dev}"

if [[ -n "$VERTEX_SA_KEY_FILE" && -f "$VERTEX_SA_KEY_FILE" ]]; then
  ok "Vertex AI key: $VERTEX_SA_KEY_FILE"
else
  warn "No VERTEX_SA_KEY_FILE — vertex credentials will use placeholder"
fi

[[ -n "$GITHUB_TOKEN" ]] && ok "GitHub token: provided" || warn "No GITHUB_TOKEN — github credentials will use placeholder"
[[ -n "$JIRA_TOKEN" ]]   && ok "Jira token: provided"   || warn "No JIRA_TOKEN — jira credentials will use placeholder"

# ── generate and execute seed SQL ─────────────────────────────────────────────

log "Generating seed SQL from examples/"

SEED_SQL=$(python3 - \
  "$REPO_ROOT" \
  "${VERTEX_SA_KEY_FILE:-}" \
  "${GITHUB_TOKEN:-}" \
  "${JIRA_TOKEN:-}" \
  "${JIRA_EMAIL:-developer@local.dev}" \
  "$NAMESPACE" \
  << 'PYEOF'
import json, os, sys, hashlib

repo_root = sys.argv[1]
vertex_key_file = sys.argv[2]
github_token = sys.argv[3]
jira_token = sys.argv[4]
jira_email = sys.argv[5]
namespace = sys.argv[6]

import yaml

def load_yaml(rel_path):
    with open(os.path.join(repo_root, rel_path)) as f:
        return yaml.safe_load(f)

def sql_esc(s):
    if s is None:
        return 'NULL'
    return "'" + str(s).replace("'", "''") + "'"

def sql_esc_or_null(s):
    if not s:
        return 'NULL'
    return sql_esc(s)

def json_esc(obj):
    return sql_esc(json.dumps(obj, separators=(',', ':')))

def seed_id(*parts):
    h = hashlib.sha256(':'.join(str(p) for p in parts).encode()).hexdigest()[:20]
    return f"seed_{h}"

vertex_credential = ''
if vertex_key_file and os.path.isfile(vertex_key_file):
    with open(vertex_key_file) as f:
        vertex_credential = f.read().strip()

credential_substitutions = {
    '$VERTEX_SA_KEY': vertex_credential or 'placeholder-vertex-key',
    '$GITHUB_PAT': github_token or 'placeholder-github-token',
    '$JIRA_API_TOKEN': jira_token or 'placeholder-jira-token',
    '$JIRA_EMAIL': jira_email,
}

def resolve_credential(raw):
    if not raw:
        return raw
    raw = str(raw)
    for var, val in credential_substitutions.items():
        if raw == var:
            return val
    return raw

sql = []
sql.append('BEGIN;')
sql.append('')

sql.append('-- ── 1. Users ──────────────────────────────────────────────────────')
users = [
    {'username': 'developer', 'name': 'Dev User',   'email': 'developer@local.dev'},
    {'username': 'admin',     'name': 'Admin User',  'email': 'admin@local.dev'},
]
for u in users:
    uid = seed_id('user', u['username'])
    sql.append(f"""INSERT INTO users (id, username, name, email, created_at, updated_at)
SELECT {sql_esc(uid)}, {sql_esc(u['username'])}, {sql_esc(u['name'])}, {sql_esc(u['email'])}, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = {sql_esc(u['username'])} AND deleted_at IS NULL);""")
sql.append('')

sql.append('-- ── 2. Platform-admin role bindings ──────────────────────────────')
for u in users:
    rb_id = seed_id('rb', u['username'], 'platform:admin', 'global')
    sql.append(f"""INSERT INTO role_bindings (id, role_id, scope, user_id, created_at, updated_at)
SELECT {sql_esc(rb_id)}, r.id, 'global', u.id, NOW(), NOW()
FROM roles r, users u
WHERE r.name = 'platform:admin' AND r.deleted_at IS NULL
  AND u.username = {sql_esc(u['username'])} AND u.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM role_bindings rb
    WHERE rb.role_id = r.id AND rb.user_id = u.id
      AND rb.scope = 'global' AND rb.deleted_at IS NULL
  );""")
sql.append('')

sql.append('-- ── 3. Projects ──────────────────────────────────────────────────')
tenants = ['tenant-a', 'tenant-b']
projects = {}
for tenant in tenants:
    proj_path = f'examples/overlays/{tenant}/project.yaml'
    if os.path.isfile(os.path.join(repo_root, proj_path)):
        p = load_yaml(proj_path)
        projects[tenant] = p
        labels = p.get('labels', {})
        sql.append(f"""INSERT INTO projects (id, name, description, prompt, labels, created_at, updated_at)
SELECT {sql_esc(p['name'])}, {sql_esc(p['name'])}, {sql_esc_or_null(p.get('description'))}, {sql_esc_or_null(p.get('prompt'))}, {json_esc(labels) if labels else 'NULL'}, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM projects WHERE name = {sql_esc(p['name'])} AND deleted_at IS NULL);""")
sql.append('')

sql.append('-- ── 4. Project-owner role bindings ───────────────────────────────')
for tenant in tenants:
    if tenant not in projects:
        continue
    for u in users:
        rb_id = seed_id('rb', u['username'], 'project:owner', tenant)
        sql.append(f"""INSERT INTO role_bindings (id, role_id, scope, user_id, project_id, created_at, updated_at)
SELECT {sql_esc(rb_id)}, r.id, 'project', u.id, {sql_esc(tenant)}, NOW(), NOW()
FROM roles r, users u
WHERE r.name = 'project:owner' AND r.deleted_at IS NULL
  AND u.username = {sql_esc(u['username'])} AND u.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM role_bindings rb
    WHERE rb.role_id = r.id AND rb.user_id = u.id
      AND rb.project_id = {sql_esc(tenant)} AND rb.scope = 'project'
      AND rb.deleted_at IS NULL
  );""")
sql.append('')

sql.append('-- ── 5. Credentials ───────────────────────────────────────────────')
credentials = {}
for tenant in tenants:
    overlay_dir = os.path.join(repo_root, f'examples/overlays/{tenant}')
    if not os.path.isdir(overlay_dir):
        continue
    for fname in sorted(os.listdir(overlay_dir)):
        if fname.startswith('credential-') and fname.endswith('.yaml'):
            cred = load_yaml(f'examples/overlays/{tenant}/{fname}')
            cred_name = cred['name']
            if cred_name in credentials:
                continue
            credentials[cred_name] = cred
            cred_id = seed_id('cred', cred_name)
            token_val = resolve_credential(cred.get('token', ''))
            url_val = cred.get('url')
            email_val = cred.get('email')
            if email_val and str(email_val).startswith('$'):
                email_val = credential_substitutions.get(str(email_val), email_val)
            sql.append(f"""INSERT INTO credentials (id, name, description, provider, token, url, email, labels, created_at, updated_at)
SELECT {sql_esc(cred_id)}, {sql_esc(cred_name)}, {sql_esc_or_null(cred.get('description'))}, {sql_esc(cred['provider'])}, {sql_esc(token_val)}, {sql_esc_or_null(url_val)}, {sql_esc_or_null(email_val)}, {json_esc(cred.get('labels', {})) if cred.get('labels') else 'NULL'}, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM credentials WHERE name = {sql_esc(cred_name)} AND deleted_at IS NULL);""")
sql.append('')

sql.append('-- ── 6. Credential-owner role bindings ────────────────────────────')
for cred_name in credentials:
    cred_id = seed_id('cred', cred_name)
    rb_id = seed_id('rb', 'developer', 'credential:owner', cred_name)
    sql.append(f"""INSERT INTO role_bindings (id, role_id, scope, user_id, credential_id, created_at, updated_at)
SELECT {sql_esc(rb_id)}, r.id, 'credential', u.id, {sql_esc(cred_id)}, NOW(), NOW()
FROM roles r, users u
WHERE r.name = 'credential:owner' AND r.deleted_at IS NULL
  AND u.username = 'developer' AND u.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM role_bindings rb
    WHERE rb.role_id = r.id AND rb.user_id = u.id
      AND rb.credential_id = {sql_esc(cred_id)} AND rb.scope = 'credential'
      AND rb.deleted_at IS NULL
  );""")
sql.append('')

sql.append('-- ── 7. Providers per project ─────────────────────────────────────')
base_providers = []
for fname in ['vertex.yaml', 'github.yaml', 'jira.yaml', 'mock-llm.yaml']:
    prov_path = f'examples/base/providers/{fname}'
    if os.path.isfile(os.path.join(repo_root, prov_path)):
        base_providers.append(load_yaml(prov_path))

tenant_providers = {
    'tenant-a': ['vertex', 'github', 'jira', 'mock-llm'],
    'tenant-b': ['vertex', 'github'],
}
for tenant in tenants:
    if tenant not in projects:
        continue
    allowed = tenant_providers.get(tenant, [])
    for prov in base_providers:
        if prov['name'] not in allowed:
            continue
        prov_id = seed_id('prov', tenant, prov['name'])
        sql.append(f"""INSERT INTO providers (id, project_id, name, type, secret, created_at, updated_at)
SELECT {sql_esc(prov_id)}, {sql_esc(tenant)}, {sql_esc(prov['name'])}, {sql_esc_or_null(prov.get('type'))}, {sql_esc_or_null(prov.get('secret'))}, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM providers WHERE project_id = {sql_esc(tenant)} AND name = {sql_esc(prov['name'])} AND deleted_at IS NULL);""")
sql.append('')

sql.append('-- ── 8. Gateways per project ──────────────────────────────────────')
for tenant in tenants:
    gw_path = f'examples/overlays/{tenant}/gateway.yaml'
    if not os.path.isfile(os.path.join(repo_root, gw_path)):
        continue
    gw = load_yaml(gw_path)
    gw_id = seed_id('gw', tenant, gw['name'])
    dns_names = gw.get('server_dns_names', [])
    labels = gw.get('labels', {})
    oidc = gw.get('oidc')
    route = gw.get('route')
    sql.append(f"""INSERT INTO gateways (id, name, project_id, image, server_dns_names, labels, oidc, route, created_at, updated_at)
SELECT {sql_esc(gw_id)}, {sql_esc(gw['name'])}, {sql_esc(tenant)}, {sql_esc_or_null(gw.get('image'))}, {json_esc(dns_names) if dns_names else 'NULL'}, {json_esc(labels) if labels else 'NULL'}, {json_esc(oidc) if oidc else 'NULL'}, {json_esc(route) if route else 'NULL'}, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM gateways WHERE project_id = {sql_esc(tenant)} AND name = {sql_esc(gw['name'])} AND deleted_at IS NULL);""")
sql.append('')

sql.append('-- ── 9. Policies per project ──────────────────────────────────────')
policy_files = ['permissive.yaml', 'locked-down.yaml', 'mock-llm-permissive.yaml']
for tenant in tenants:
    if tenant not in projects:
        continue
    for pf in policy_files:
        pol_path = f'examples/base/policies/{pf}'
        if not os.path.isfile(os.path.join(repo_root, pol_path)):
            continue
        pol = load_yaml(pol_path)
        pol_id = seed_id('pol', tenant, pol['name'])
        spec = pol.get('spec', {})
        sql.append(f"""INSERT INTO policies (id, project_id, name, spec, created_at, updated_at)
SELECT {sql_esc(pol_id)}, {sql_esc(tenant)}, {sql_esc(pol['name'])}, {json_esc(spec)}::jsonb, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM policies WHERE project_id = {sql_esc(tenant)} AND name = {sql_esc(pol['name'])} AND deleted_at IS NULL);""")
sql.append('')

sql.append('-- ── 10. Agents per project ───────────────────────────────────────')
agent_files = sorted([
    f for f in os.listdir(os.path.join(repo_root, 'examples/base/agents'))
    if f.endswith('.yaml') and f != 'kustomization.yaml'
])
tenant_agents = {
    'tenant-a': agent_files,
    'tenant-b': agent_files,
}
for tenant in tenants:
    if tenant not in projects:
        continue
    allowed = tenant_agents.get(tenant, [])
    for af in allowed:
        agent_path = f'examples/base/agents/{af}'
        if not os.path.isfile(os.path.join(repo_root, agent_path)):
            continue
        agent = load_yaml(agent_path)
        agent_id = seed_id('agent', tenant, agent['name'])
        providers_json = agent.get('providers', [])
        payloads_json = agent.get('payloads', [])
        env_json = agent.get('environment', {})
        labels = agent.get('labels', {})
        sandbox_policy = agent.get('sandbox_policy')
        llm_model = 'claude-sonnet-4-6'
        sql.append(f"""INSERT INTO agents (id, project_id, owner_user_id, name, prompt, providers, payloads, environment, sandbox_policy, labels, llm_model, llm_temperature, llm_max_tokens, created_at, updated_at)
SELECT {sql_esc(agent_id)}, {sql_esc(tenant)}, u.id, {sql_esc(agent['name'])}, {sql_esc_or_null(agent.get('prompt'))}, {json_esc(providers_json) if providers_json else 'NULL'}::jsonb, {json_esc(payloads_json) if payloads_json else 'NULL'}::jsonb, {json_esc(env_json) if env_json else 'NULL'}::jsonb, {sql_esc_or_null(sandbox_policy)}, {json_esc(labels) if labels else 'NULL'}, {sql_esc(llm_model)}, 0.7, 4000, NOW(), NOW()
FROM users u
WHERE u.username = 'developer' AND u.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM agents WHERE project_id = {sql_esc(tenant)} AND name = {sql_esc(agent['name'])} AND deleted_at IS NULL);""")
sql.append('')

sql.append('COMMIT;')

print('\n'.join(sql))
PYEOF
)

if [[ -z "$SEED_SQL" ]]; then
  fail "Failed to generate seed SQL"
fi

log "Executing seed SQL against $DB_NAME"

RESULT=$(echo "$SEED_SQL" | $CLI exec -i -n "$NAMESPACE" "$DB_POD" -- \
  psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 2>&1) || {
  echo "$RESULT"
  fail "Seed SQL execution failed"
}

ok "Seed SQL executed successfully"

# ── verify ────────────────────────────────────────────────────────────────────

log "Verifying seeded data"

COUNTS=$($CLI exec -n "$NAMESPACE" "$DB_POD" -- \
  psql -U "$DB_USER" -d "$DB_NAME" -tA -c "
    SELECT 'users=' || COUNT(*) FROM users WHERE deleted_at IS NULL
    UNION ALL
    SELECT 'role_bindings=' || COUNT(*) FROM role_bindings WHERE deleted_at IS NULL
    UNION ALL
    SELECT 'projects=' || COUNT(*) FROM projects WHERE deleted_at IS NULL
    UNION ALL
    SELECT 'credentials=' || COUNT(*) FROM credentials WHERE deleted_at IS NULL
    UNION ALL
    SELECT 'providers=' || COUNT(*) FROM providers WHERE deleted_at IS NULL
    UNION ALL
    SELECT 'gateways=' || COUNT(*) FROM gateways WHERE deleted_at IS NULL
    UNION ALL
    SELECT 'policies=' || COUNT(*) FROM policies WHERE deleted_at IS NULL
    UNION ALL
    SELECT 'agents=' || COUNT(*) FROM agents WHERE deleted_at IS NULL
    UNION ALL
    SELECT 'roles=' || COUNT(*) FROM roles WHERE deleted_at IS NULL;
  " 2>/dev/null)

while IFS= read -r line; do
  [[ -n "$line" ]] && info "$line"
done <<< "$COUNTS"

log "Seed complete for $NAMESPACE"
echo ""
echo "  Seeded users:    developer (platform:admin), admin (platform:admin)"
echo "  Seeded projects: tenant-a, tenant-b"
echo "  Seeded from:     examples/overlays/ and examples/base/"
echo ""
echo "  Next step:"
echo "    bash components/pr-test/e2e-smoke.sh $NAMESPACE"
echo ""
