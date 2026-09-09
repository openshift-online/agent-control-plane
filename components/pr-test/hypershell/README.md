# ACP with a Hypershell service

These files prepare an isolated ACP test namespace. They use an existing
Hypershell service and OIDC realm. They do not change the current `oc` context.
The code that connects ACP to Hypershell supplies `control_plane_env` in the
configuration file. The example has no connection variables and is not a
complete deployment configuration. See `jshell-evidence.md` for the current
cluster state and completed checks.

## Cluster inspection: 2026-09-09

The `jshell` cluster has these services:

| Resource | State |
| --- | --- |
| Hypershell API, controller, web console, PostgreSQL | Each deployment has one ready pod |
| Keycloak | One ready pod; HTTPS OIDC discovery succeeds |
| Agent Sandbox controller | One ready pod |
| cert-manager | Controller, webhook, and CA injector are ready |
| Storage | `gp3-csi` is the default; new volume creation fails |
| Internal image registry | The `default-route` is available |
| `acp-hypershell` namespace | Not present during inspection |

Hypershell API rejects an unauthenticated gateway list request with HTTP 401.
The existing `openshell-934c33c811ba0575` namespace has no gateway workloads.
Read-only database inspection found no active fleets, gateway releases, or
managed clusters. The only active managed database is failed. Its PVC cannot
provision a volume: AWS STS rejects `AssumeRoleWithWebIdentity` with HTTP 403.
Repair the CSI role trust or supply working storage before deployment. One
node also reports insufficient memory for the pending database pod.

There is no cluster issuer. Inspect each gateway's namespaced issuer when it
is created. A ready controller alone does not prove gateway provisioning.

The existing Hypershell images come from different source revisions:

| Component | Source tag | Running image digest |
| --- | --- | --- |
| API | `pr210-236bd3d` | `sha256:5188552c32eaaeb0dcd9478c381b513e48f875552ee787c5c31b2d7b2e650576` |
| Controller | `935baba-hypershell-system` | `sha256:d07e4b2e9911d032f531900c54c11c8b299a17307645a247a0812fcc03b56d45` |
| Web console | `pr210-236bd3d` | `sha256:4ff195b56e307837475475fb7cecf77fa120a47fb10cee7885ee7bf2910fa5a5` |

The API source at `236bd3d` has gateway service-account APIs. The controller
has no `GATEWAY_IMAGE` environment variable. Read the selected gateway release
from Hypershell before creating a gateway. Do not assume that the live service
uses the image in the current source manifest.

Service URLs:

- Hypershell API: `https://hypershell-api-hypershell-system.apps.rosa.jshell.8u58.p3.openshiftapps.com`
- Hypershell UI: `https://hypershell.apps.rosa.jshell.8u58.p3.openshiftapps.com`
- OIDC realm: `https://keycloak.apps.rosa.jshell.8u58.p3.openshiftapps.com/realms/hypershell`
- Image registry: `default-route-openshift-image-registry.apps.rosa.jshell.8u58.p3.openshiftapps.com`

Reuse Hypershell for the first gateway test. Create a dedicated ACP OIDC client
and separate gateway resources. If the existing API cannot meet the required
contract, deploy a separate Hypershell API, database, and controller. Do not
upgrade the shared service as a side effect of ACP installation.

## Prepare and build

Set the context on every command through the supplied wrapper:

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

Builds run in local Podman and push to the internal image registry. The OpenShift
token is passed through standard input. Temporary registry credentials are
removed when the script exits. The build scripts print the resulting image reference. Use
those references, with digests, in a copy of `config.example.json`. Build from a
committed source tree so the recorded revision identifies the source.

Gateway sandbox service accounts need pull access to the runner image. Give
`system:image-puller` in the ACP image namespace to each specific gateway
service account. Do not grant pull access to all service accounts in the cluster.
Alternatively, publish the runner image to a registry that those gateways can
already read.

## Configure authentication and apply

Create confidential OIDC clients named by `cp_client_id` and `ui_client_id`.
Enable the client credentials grant for the control plane. Configure the UI
client with the exact HTTPS callback URL shown by `render.py`. Give the control
plane the ACP service identity claims. Configure user roles for ACP access.
Use a separate authorized Hypershell client for gateway management. Gateway
service-account credentials are separate from both ACP client credentials.

Store the two ACP client secrets in local files with mode `0600`. Do not put
secret values in `config.json`, shell arguments, or source control. Connection
environment variables can use Kubernetes `secretKeyRef` records.

```bash
python3 components/pr-test/hypershell/render.py /private/path/config.json > /tmp/acp-resources.json
python3 components/pr-test/hypershell/setup-secrets.py /private/path/config.json \
  --cp-client-secret-file /private/path/cp-secret \
  --ui-client-secret-file /private/path/ui-secret
components/pr-test/hypershell/apply.sh /private/path/config.json
```

Rendering does not contact the cluster. `setup-secrets.py` preserves the database
password, encryption key, and session key on repeat runs. It applies secret
values through standard input and does not print them. `apply.sh` requires all
secrets before it applies the workloads. PostgreSQL uses a PVC. All containers
use a read-only root filesystem and restricted security settings.

The control plane has a namespace Role for Secrets and ConfigMaps. If the
integration requires more permissions, add the specific resources after review.
It has no authority to create gateway workloads or namespaces in this manifest.
Hypershell must own those resources.

## Required deployment proof

Record the source revision, all running image digests, test workspace and gateway
IDs, session and sandbox IDs, and HTTPS routes. Verify these operations:

1. Sign in through the ACP UI. Reject requests without valid authentication.
2. Create an ACP workspace and observe a ready Hypershell gateway.
3. Create two sessions with separate sandboxes and inference settings.
4. Select an ACP credential and confirm that its exact provider record is used.
5. Rotate and revoke that credential. Confirm that the changes reach OpenShell.
6. Replace a control-plane pod and confirm recovery without duplicate gateways.
7. Stop and delete sessions. Delete the test workspace and confirm cleanup.
8. Leave a ready workspace for user approval.

A successful rollout is a prerequisite for these tests. It is not the test
result. See `jshell-evidence.md` for the resources applied during preparation.

## Isolated Hypershell setup

`render-hypershell.py` reads the selected Hypershell checkout's base manifests.
It creates a separate database, API, controller, CA issuer, and Route. It does
not deploy another Keycloak service or change the shared Hypershell service.
It requires PyYAML. Supply a JSON configuration with `namespace`, `oidc_issuer`,
`apps_domain`, `cp_client_id`, `storage_class`, `api_image`, and `controller_image`.

`bootstrap-oidc.py` can create the test clients through the existing Keycloak
Admin API. It reads the test deployment's bootstrap admin settings through the
selected cluster context. Client secrets are written to a private output
directory. It does not print secret values.

`seed-hypershell.py` creates or checks the dedicated managed cluster and gateway
image release. It writes the gateway template to a private local file. Configure
`HYPERSHELL_GATEWAY_TEMPLATE` with that JSON. Configure
`HYPERSHELL_SANDBOX_DRIVER_CONFIG` with `workspace_storage_class` when a specific
class is required. Hypershell uses `DATABASE_STORAGE_CLASS` for new gateway
database PVCs. Existing PVCs keep their storage class.

Before applying ACP, include the namespace's `openshift-service-ca.crt`
ConfigMap value as `service_ca` in its JSON configuration. The renderer sets the
public gRPC Route's destination CA from this value. `setup-secrets.py` creates
the runner keypair before the API mounts its public key.


For public gRPC on an OpenShift default ingress certificate, use a dedicated
certificate and passthrough Route. The default ingress certificate does not
permit HTTP/2 on a reencrypt Route. Run `setup-tls.py config.json` with
`ACP_OC_CONTEXT` set. This creates a dedicated test ClusterIssuer and an ACP
server certificate. It puts the public CA and system roots in a ConfigMap.
The CA private key stays in the cert-manager namespace. Set Hypershell
`GATEWAY_SERVER_TLS_CLUSTER_ISSUER` to `<ACP namespace>-test-ca` so each gateway
server uses the same trusted issuer. The control plane supplies this trust
bundle to runner startup. Browser UI and token Routes keep public certificates.

The operator must renew the trust ConfigMap after CA rotation. This script is
for the review deployment; a production installation needs a managed trust
bundle and certificate rotation process.


When runner images use the private OpenShift registry, run
`grant-runner-pull.py <gateway-namespace>` after each workspace gateway namespace
exists. This permits only its sandbox service account to pull the runner image.
The RoleBinding has a Namespace owner reference, so namespace deletion also
removes that binding. The script rejects namespaces from other Hypershell
instances. No registry token is copied to a gateway namespace.


Image builds use an archive of the committed Git revision. Commit source changes
before running `build.sh`. This keeps the image source and its revision label
in agreement when another task edits the shared worktree.

The isolated Hypershell configuration can set `database_memory_request` and
`gateway_memory_request`. Both use `128Mi` in this test deployment. Hypershell
validates these quantities and retains its existing 512Mi limits. Without these
settings, its current memory requests stay unchanged.
