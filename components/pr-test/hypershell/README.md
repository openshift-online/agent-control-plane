# ACP with a Hypershell service

These files deploy ACP to an isolated OpenShift test namespace. Hypershell owns
each workspace gateway and its database. OpenShell owns each session sandbox.
All cluster commands require an explicit `ACP_OC_CONTEXT`; no script changes
the current context. See [jshell-evidence.md](jshell-evidence.md) for deployed
revisions, resource IDs, completed checks, and remaining work.
See [approval-verification.md](approval-verification.md) for the checks required
before user approval and the limits of the current deployment evidence.

## Build the ACP images

```bash
export ACP_OC_CONTEXT=default/api-jshell-8u58-p3-openshiftapps-com:443/johnsell
export ACP_NAMESPACE=acp-hypershell
export ACP_IMAGE_TAG="$(git rev-parse --short=12 HEAD)"
components/pr-test/hypershell/preflight.sh
components/pr-test/hypershell/oc.sh create namespace "$ACP_NAMESPACE" --dry-run=client -o yaml |
  components/pr-test/hypershell/oc.sh apply -f -
components/pr-test/hypershell/build.sh api-server
components/pr-test/hypershell/build.sh control-plane
components/pr-test/hypershell/build.sh ui
components/pr-test/hypershell/build.sh runner
```

Builds use local Podman and an archive of the committed Git revision. Commit
source changes before running the build script. This keeps the source and image
revision label in agreement during concurrent worktree edits. The runner build
uses `Dockerfile.openshell`. Archive permissions do not depend on the build
process umask. Check the built runner with an arbitrary UID before deployment:

```bash
components/pr-test/hypershell/verify-runner-permissions.sh "localhost/acp-claude-runner:$ACP_IMAGE_TAG"
```

The build script passes the OpenShift token to the registry through standard
input and removes its temporary registry credentials on exit. It prints an
image reference with a digest. Put each reference in a private copy of
`config.example.json`.

## Configure authentication and TLS

`bootstrap-oidc.py` creates dedicated clients in the existing test Keycloak
realm for ACP. Use a separate realm for each isolated Hypershell instance, as
described below. It reads the test Keycloak deployment's bootstrap admin settings through
the explicit cluster context. It writes client secrets to a private directory.
The UI client has an exact HTTPS callback URL. ACP and Hypershell management
use separate confidential clients. The manager receives `gateway:creator`.

Store local secret files with mode `0600`. Do not put their values in source
control, shell arguments, or `config.json`. The `control_plane_env` list accepts
Kubernetes `secretKeyRef` records. Set these connection variables:

- `HYPERSHELL_API_URL`: the authenticated Hypershell API base URL.
- `HYPERSHELL_OIDC_TOKEN_URL`, `HYPERSHELL_OIDC_CLIENT_ID`, and
  `HYPERSHELL_OIDC_CLIENT_SECRET`: the gateway management identity.
- `HYPERSHELL_INSTANCE_ID`: a stable UUID for this ACP installation.
- `HYPERSHELL_GATEWAY_TEMPLATE`: the JSON produced by `seed-hypershell.py`.
- `HYPERSHELL_SANDBOX_DRIVER_CONFIG`: optional per-sandbox driver settings.
  The pinned Kubernetes driver accepts `pod`, `containers`, and `volumes`.
  For example, `containers.agent.resources.requests` sets resource requests.
  Workspace storage settings belong to the Hypershell controller configuration.

`api_memory_request` sets the API pod memory request. It defaults to `64Mi` and
accepts integer Mi units from `1Mi` to `1024Mi`. Its limit stays `1Gi`. The jshell
test uses `48Mi` after observing `21Mi` of API memory use.

```bash
python3 components/pr-test/hypershell/setup-secrets.py /private/path/config.json \
  --cp-client-secret-file /private/path/cp-secret \
  --ui-client-secret-file /private/path/ui-secret
python3 components/pr-test/hypershell/setup-tls.py /private/path/config.json
components/pr-test/hypershell/apply.sh /private/path/config.json
```

`setup-secrets.py` preserves the database password, credential encryption key,
runner signing key, and UI session key on repeat runs. The API receives only
the runner public key. Plaintext credential storage is disabled. Secret values
pass to `oc` through standard input and are not printed.

`setup-tls.py` creates a dedicated test ClusterIssuer and an ACP certificate
with public gRPC and internal service DNS names. The CA private key stays in
the cert-manager namespace. A ConfigMap contains its public CA and system
roots. The public gRPC Route uses passthrough TLS; the REST Route uses
reencrypt TLS. OpenShift's default ingress certificate does not permit HTTP/2
on a reencrypt Route. See the [Red Hat ingress documentation](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/networking_operators/configuring-ingress).

The deployment enables enhanced TLS for REST and gRPC and disables Kubernetes
TLS auto-detection. The control plane uses HTTPS for the internal API. It
receives the public trust bundle through `SSL_CERT_FILE`, `CA_CERT_FILE`, and
`HYPERSHELL_CA_CERT_FILE`. The last variable also supplies gateway trust and the
runner CA payload. The UI receives the bundle through `NODE_EXTRA_CA_CERTS`.
Browser UI and token Routes use the cluster's publicly trusted certificate.

After CA rotation, run TLS setup again to refresh the public trust ConfigMap
and restart its consumers. A production installation needs an automatic trust
and certificate rotation process.

`apply.sh` requires configured TLS, built images, and all Secrets. It waits for
OpenShift service account image pull Secrets before creating pods. Deployments
use Recreate. PostgreSQL uses a PVC. Containers use restricted security settings
and read-only root filesystems. The ACP control plane has namespace access to
its signing Secret and ConfigMaps; it cannot create gateway namespaces or
workloads.

## Deploy isolated Hypershell

`render-hypershell.py` reads a compatible Hypershell checkout's base manifests.
It renders a separate database, API, controller, CA issuer, and Route. It does
not deploy Keycloak or upgrade shared Hypershell services. It requires PyYAML.
Supply `namespace`, `oidc_issuer`, `apps_domain`, `cp_client_id`, `storage_class`,
`api_image`, and `controller_image` in a private JSON configuration. Supply the
Hypershell database, API client, and Keycloak provisioner Secrets before apply.
The source base manifests define their required keys.

Create an owned realm before starting the isolated Hypershell API:

```bash
python3 components/pr-test/hypershell/bootstrap-hypershell-realm.py /private/path/hypershell-config.json \
  --realm hypershell-acp-jshell \
  --instance-id "$HYPERSHELL_INSTANCE_ID" \
  --manager-client-id acp-hypershell-manager \
  --provisioner-client-id acp-hypershell-provisioner \
  --output-dir /private/path/isolated-realm
```

The instance ID must match the stable ACP installation ID. The script refuses
an existing realm owned by another installation. It creates the controller,
manager, and provisioner clients, verifies their identities, and preserves
client secrets on repeat runs. The provisioner receives client and user
management permissions only in this realm.

Set `oidc_issuer` from the output `realm.json`. Use the three output secret files
for the corresponding Kubernetes Secret keys. Set ACP's Hypershell token URL
to this realm; leave ACP's own browser and machine token URLs unchanged. Do not
copy secret values into configuration or command arguments. A second Hypershell
instance must not share a realm with an older instance whose orphan cleanup
cannot distinguish instance ownership.
Use [hypershell-config.example.json](hypershell-config.example.json) as a starting
point and replace the image references with built digests.

The Hypershell source must support caller-scoped `external_reference`, verified
gateway deletion completion, configurable database storage, and
`GATEWAY_SERVER_TLS_CLUSTER_ISSUER`. Set `server_tls_cluster_issuer` to
`<ACP namespace>-test-ca`. Each gateway server then uses the same issuer trusted
by ACP. Client credentials remain separate from the shared server CA.

The configuration can set `database_memory_request` and
`gateway_memory_request`. Both use `128Mi` in this test deployment. Hypershell
validates these quantities and retains its 512Mi container limits. Without
these settings, its memory requests stay unchanged.

`seed-hypershell.py` creates or checks the dedicated managed cluster and gateway
image release. It writes the gateway template to a private file. The current
create schema requires an empty `database_id` placeholder; Hypershell assigns
the database. `DATABASE_STORAGE_CLASS` selects the class for new gateway
database PVCs. Existing PVCs keep their class.

In the Hypershell configuration, `workspace_storage_class` and
`workspace_default_storage_size` set `GATEWAY_WORKSPACE_STORAGE_CLASS` and
`GATEWAY_WORKSPACE_DEFAULT_STORAGE_SIZE` on the controller. Hypershell writes
them under `[openshell.drivers.kubernetes]` for sandbox workspace PVCs. The
jshell test uses `acp-hypershell-gp3` and `2Gi`. If omitted, OpenShell selects the
cluster default storage class and its default size. Do not put these keys in
`HYPERSHELL_SANDBOX_DRIVER_CONFIG`: the pinned request schema rejects them.

For private OpenShift runner images, configure `sandbox_image_pull_roles` in the
Hypershell JSON configuration as an array of `namespace` and `role` objects.
The renderer passes this array through `GATEWAY_SANDBOX_IMAGE_PULL_ROLES` and
grants the Hypershell controller `bind` permission on only those named Roles.
An optional `image_pull_role_definitions` array creates the approved Roles at
installation time. Each definition has `namespace`, `role`, and `image_streams`;
the generated Role grants only `get` on those named image streams' layers. See
the Hypershell example configuration. Apply the full rendered resources so the
image Roles and bind permissions exist before gateway provisioning.

Hypershell then creates, repairs, and deletes a RoleBinding for each gateway's
configured sandbox service account. This supports the pinned gateway's shared
workspace mode; other modes are rejected. New ACP workspaces need no manual
grant. Grant failures keep the gateway from becoming Healthy. ACP receives no
Kubernetes access, and registry tokens are not copied to gateway namespaces.

`grant-runner-pull.py <gateway-namespace>` remains a manual fallback for an older
Hypershell deployment. It grants only the sandbox account access to the runner image.
The script reads the account name from the live gateway driver configuration
and requires Python 3.11 or later. The jshell account is
`openshell-gateway-sandbox`. An explicit `--sandbox-service-account` can override
discovery. A repeat run replaces the prior subject in the same RoleBinding.
The RoleBinding has a Namespace owner reference. Namespace deletion therefore
removes the binding. The script rejects namespaces from other Hypershell
instances. It does not copy registry tokens to gateway namespaces.

## Required deployment proof

Record source revisions, image digests, workspace and gateway IDs, session and
sandbox IDs, and HTTPS routes. Verify these operations:

1. Sign in through the ACP UI and reject requests without authentication.
2. Create a workspace and observe a ready Hypershell gateway.
3. Create two sessions with separate sandboxes and inference settings.
4. Confirm that a selected credential maps to its exact provider record.
5. Rotate and revoke the credential and verify OpenShell convergence.
6. Replace a control-plane pod and verify recovery without duplicate gateways.
7. Stop and delete sessions, then verify workspace cleanup.
8. Leave a ready workspace for user approval.

A successful rollout is a prerequisite for these tests. It does not prove
session execution.
