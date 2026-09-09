# jshell deployment evidence

This record covers infrastructure preparation. ACP session approval tests are
still required. The final revision table below takes precedence over earlier
observations in this record. All cluster commands used this explicit context:

`default/api-jshell-8u58-p3-openshiftapps-com:443/johnsell`

## Storage repair

The CSI credential Secret named an IAM role that no longer existed. The cluster
OIDC provider still existed. AWS account: `765374464689`; region: `us-east-1`.

Restored role:

`jsell-hypershell-dev-yffe-openshift-cluster-csi-drivers-ebs-clou`

The trust policy is in `jshell-csi-trust.json`. It permits only the CSI controller
and operator service accounts from this cluster. The attached AWS policy is:

`arn:aws:iam::aws:policy/service-role/ROSAAmazonEBSCSIDriverOperatorPolicy`

A temporary attachment of `AmazonEBSCSIDriverPolicy` was removed. The final
role has only the ROSA policy. Both the default CSI request and the dedicated
storage class carry `red-hat-managed=true`. IAM propagation caused a delay after
restoration. A fresh CSI identity passed an EC2 CreateVolume dry-run.

A restricted test pod used a 1Gi PVC on `acp-hypershell-gp3`. The PVC became
Bound, and the pod wrote and read `storage-ok`. The test pod and PVC were then
deleted. The shared default storage class was not changed.

To remove the restored role after all dependent storage has been removed:

```bash
aws iam detach-role-policy \
  --role-name jsell-hypershell-dev-yffe-openshift-cluster-csi-drivers-ebs-clou \
  --policy-arn arn:aws:iam::aws:policy/service-role/ROSAAmazonEBSCSIDriverOperatorPolicy
aws iam delete-role \
  --role-name jsell-hypershell-dev-yffe-openshift-cluster-csi-drivers-ebs-clou
```

These commands undo the repair and stop CSI storage operations. They were not run.

## Isolated Hypershell

Namespace: `acp-hypershell-system`.

API: `https://hypershell-api-acp-hypershell-system.apps.rosa.jshell.8u58.p3.openshiftapps.com`

The API and controller now run digest-pinned images from Hypershell commit
`cbc5442`. This includes persistent storage configuration, the OpenShift database
UID fix, caller-scoped gateway references, and verified deletion completion.
The existing shared Hypershell deployments were not upgraded.

PostgreSQL has a bound 5Gi PVC. A restricted init container supplies a passwd
entry for the assigned OpenShift UID. PostgreSQL keeps a read-only root
filesystem. No SCC exception was needed.

Authenticated manager requests to `managed_clusters` and `gateways` returned
HTTP 200. Dedicated records were created through the API:

| Record | ID |
| --- | --- |
| Managed cluster `acp-jshell` | `3J69rJC7eofC9F9XiVJtABWBdkw` |
| Gateway image release `acp-openshell-v0.0.109-rhaiv.0` | `3J69rGTlaomdv8DOCcx3bgiWiHO` |

The cluster record refers to a kubeconfig that uses the controller pod's service
account token file. It contains no copied bearer token.

## ACP preparation

Namespace: `acp-hypershell`.

Dedicated OIDC clients are `acp-hypershell-ui`, `acp-hypershell-cp`, and
`acp-hypershell-manager`. The manager has the `gateway:creator` realm role.
Hypershell uses the separate `acp-hypershell-service` client for its controller.

The ACP database password, RSA runner keypair, credential encryption keyring,
and UI session key are in Kubernetes Secrets. Repeat setup preserves these
values. The API has plaintext credential storage disabled.

Operator configuration and client secret files are in the local directory
`/home/jsell/.cache/acp-hypershell-jshell`. The directory has mode `0700` and
secret files have mode `0600`. These files are not in source control. The ACP
configuration file is `config.json`. API, control plane, and runner images now come from
ACP commit `c64d811c`. Final ACP
source changes require another image build before approval tests.

The jshell and Keycloak HTTPS certificates pass system trust verification.
The ACP manifest uses a passthrough Route for public gRPC and a dedicated
certificate with public and internal DNS names. The REST API uses a reencrypt
Route. The token callback uses an HTTPS Route.

The three worker nodes have limited memory request capacity. Only the new test
workload requests were reduced. Two concurrent agent sessions can require more
worker capacity; this must be checked during the session tests.


## Service checks and capacity

The ACP API and database reached Ready. An unauthenticated public sessions
request returned HTTP 401. The ACP control plane acquired an OIDC client token
and started the Hypershell backend. Its public API address is:

`https://ambient-api-server-acp-hypershell.apps.rosa.jshell.8u58.p3.openshiftapps.com`

OpenShift adds service account image pull Secrets asynchronously. The apply
script now waits for these Secrets before it creates pods. Deployments use
Recreate to avoid extra replicas in this test namespace. The ACP database used
40Mi in the observed sample; its request is 64Mi.

The cluster has three `m8i-flex.large` workers. Its OCM cluster ID is
`2sf62fcjk3cr6ob60log2b05mtfb7im5`, and its worker pool is `workers`.
The current OCM login cannot access this cluster. The OCM API returns Forbidden,
and the ROSA CLI lists no clusters. No worker size change was made. One more
worker is needed to test gateway and sandbox workloads without reducing
unrelated workload requests.

The Keycloak realm has no identity provider. Existing human usernames are
`admin`, `developer`, and `platform-admin`. There was no `johnsell` realm user.
A dedicated `johnsell` user was then created with the `hypershell-users` role.
Its password is in the private local file `johnsell-password`.


## TLS configuration

The default OpenShift ingress certificate does not negotiate HTTP/2 for a
reencrypt Route. A dedicated `acp-hypershell-test-ca` ClusterIssuer signs the
ACP public gRPC certificate. Its private key remains in the cert-manager
namespace. ACP mounts only a public trust bundle. Each Hypershell gateway
server must use this issuer through `GATEWAY_SERVER_TLS_CLUSTER_ISSUER`.

The rh-trex-ai 0.0.31 legacy `--grpc-enable-tls` flag alone leaves gRPC
plaintext. The deployment enables the enhanced TLS settings for REST and gRPC:
`--enable-tls=true`, `--tls-cert-file`, `--tls-key-file`, and
`--tls-auto-detect-kubernetes=false`. The last setting prevents automatic
Kubernetes client TLS configuration from replacing the server certificate.
The control plane uses HTTPS for the internal API URL and mounts merged roots
through `SSL_CERT_FILE`, `CA_CERT_FILE`, and `HYPERSHELL_CA_CERT_FILE`.
The last variable supplies the gateway trust and runner CA payload. The UI
uses the same public trust ConfigMap through `NODE_EXTRA_CA_CERTS`.


The public gRPC handshake then passed certificate verification and negotiated
ALPN `h2`. A `grpcurl` reflection request without a token returned
`Unauthenticated`, which proves that the public TLS path reached the protected
gRPC server. The control plane resumed successful runtime inventory requests
over HTTPS.


## First workspace

Workspace `jshell-hypershell-test` was created through the authenticated ACP API.
A normal API role binding gives `johnsell` the `project:owner` role. ACP created
Hypershell gateway `3J6BJgdqGcVTB92p3JCnhkgfkEn`. Its namespace is
`openshell-13839a239b6b75e9`; its database namespace is
`openshell-db-f83c619409286167`.

The current Hypershell create schema requires a `database_id` key, although the
server assigns its value. The template therefore sends an empty value. This
resolved the first HTTP 400 response without creating a duplicate gateway.

The runner image pull grant is limited to the gateway's default service
account and the `acp-claude-runner` image stream. An authorization check returned
`yes`. The gateway database pod initially requested 256Mi. After the memory request
configuration was deployed, it requests 128Mi and remains Pending because all
three workers have insufficient memory. Its PVC waits for a schedulable
consumer. A fourth worker is still needed before sandbox tests can proceed.


Observed API memory use was about 20Mi per process. The test API requests are
64Mi each. This allowed the UI image from ACP commit `86d13cf5` to start while
capacity expansion remained pending. The UI address is:

`https://ambient-ui-acp-hypershell.apps.rosa.jshell.8u58.p3.openshiftapps.com`

Hypershell commit `cbc5442` adds validated memory request settings and the
shared server certificate issuer. Its API and controller images are deployed and Ready.


The browser login passed after the dedicated user profile was set from local
Git configuration. The user sees `jshell-hypershell-test` with the Owner role.
Authenticated public gRPC reflection also passed and listed eight services.
The gateway database was still pending at this point. Its later state is
recorded below.


The gateway database later took a free scheduling slot during the ACP control
plane update. Its 1Gi PVC became Bound, and PostgreSQL completed startup. The
new ACP control plane then established both project and session gRPC watch
streams over verified TLS. The test UI was temporarily scaled to zero to free
capacity. It must be restored before user approval.

Hypershell created the gateway server and console pods. Both remain Pending
for memory. The server certificate uses `acp-hypershell-test-ca` and includes
the public gateway hostname. The separate sandbox TLS Secret has a public
server CA and an owner reference to the gateway client Secret. The certificate
generation Job completed.


## Prepared session checks

The normal ACP API has two sessions in `jshell-hypershell-test`. Each session
has its own agent and credential record. Both credentials use the same existing
user ADC identity; they are not separate cloud identities. The database stores
both tokens in encrypted form.

| Model | Session ID | Credential ID |
| --- | --- | --- |
| Claude Haiku 4.5 | `3J6CUL5MoYr2eykRRkgSktf4IYE` | `3J6CUHm6FYJWpJAXCdRgaXSUhSt` |
| Claude Sonnet 4.5 | `3J6CUSoEhn9Zj2akpxAHEwkcWmk` | `3J6CULUofYmakWfvXiK3e7ej719` |

The Vertex project and region came from the user's configured environment.
Direct ADC refresh and model catalog requests succeeded. A direct Haiku request
returned the expected test text. These requests did not run through OpenShell
and do not prove sandbox inference or credential isolation.

All 446 UI tests passed. API PostgreSQL integration tests passed for runtime
updates, projects, sessions, credentials, and access control. API lint passed.
Control-plane tests and vet passed; lint found no new issues against `origin/main`.
OpenShell transport race tests passed. The final code also uses the finite
`GetSandboxLogs` RPC for snapshots. The watch RPC does not terminate after its
initial event and is not suitable for a cleanup snapshot.

The gateway and console are still Pending for memory. Live session execution,
credential rotation and revocation, recovery, and cleanup proof remain pending.
The UI must be restored before this deployment is offered for user approval.


## Current revision record

ACP review: [PR 482](https://github.com/openshift-online/agent-control-plane/pull/482).
Hypershell review: [PR 260](https://github.com/openshift-online/hypershell/pull/260).
Both PRs remain drafts until live session checks pass.

| Image | Source commit | SHA-256 digest |
| --- | --- | --- |
| ACP API | `95264f99` | `feb8319e05e94e0fc7a83cac53fff9ad4d4b7cf89f1429a306dcb8d44e936305` |
| ACP control plane | `33b69273` | `f9038ab6b407a8a7857fb827aab193887c4c2be8e1b79606e4c1dbaca6879ea3` |
| ACP UI | `95264f99` | `a3868c1dd976c1865b87d14f731c41217254e5fe51be114e785ccf372d9ca185` |
| ACP runner | `95264f99` | `0d677d416128d4aa6bbed07d76c0c5f37f7e8b5e03d6ceb98106b6544762736d` |
| Hypershell API | `e66e994` | `704126e10a001faa577af3003fc40dec6ba92e7f2b17b10934364c2842d79ab5` |
| Hypershell control plane | `1375696` | `7482d2e07028fe5c5c716876144373524efd01af9bfaee217e65738c8ca9a07a` |

All image builds used a Git archive of the stated commit. The later control
plane commits contain the SDK allocation fix and the gateway TOML fix. The
runtime source for the other images did not change after their builds.

Deployment changes through ACP commit `eabc942b` give each migration container
its own temporary directory. The server and migration no longer create the
same glog filename. The test ACP API requests 48Mi and retains its 1Gi limit.
Its observed memory use was 21Mi. The default API request remains 64Mi.

The ACP API and control plane are Ready with zero restarts. Project and session
watch streams connected over verified TLS at 17:04:39 UTC on 2026-09-09.
REST authentication, public gRPC certificate verification, HTTP/2 negotiation,
and the runner image pull grant pass. The UI has its final image but remains
scaled to zero because the cluster lacks capacity.

The first gateway process rejected `credential_drivers` inside the OIDC TOML
section. Hypershell commit `b9c136e` puts this setting in the gateway table and
adds a structural regression test. The final Hypershell controller includes
this fix. Live parsed configuration has the setting in the correct table.


The corrected gateway replica has not started. During replacement of the failed
replica, another pending workload used the released memory. The test gateway's
console was temporarily scaled to zero, but Hypershell restored its desired
replica count. No workload in the other gateway namespace was changed. The
corrected gateway and test console are now Pending for memory.

A fourth worker is required for further live checks. The current OCM identity
cannot change this cluster's worker pool. The user was asked to increase the
pool from three to four workers or supply an OCM login with cluster access.
Gateway authentication, sandbox execution, credential convergence, recovery,
and cleanup remain unproven. The ACP UI must be restored after capacity is added.


## Final configuration checks

The actual sandbox service account is `openshell-gateway-sandbox`. The runner
pull script now reads this name from the gateway configuration. Its narrow
image pull permission passes; the old `default` account permission is removed.
The dedicated account already has Hypershell's native sandbox SCC binding.
The [approval verification](approval-verification.md) records the elevated
sandbox context and the runtime security checks that remain required.

Workspace storage settings are gateway-wide Kubernetes driver settings. They
are not valid fields in a per-sandbox driver request. Hypershell now validates
and renders `GATEWAY_WORKSPACE_STORAGE_CLASS` and
`GATEWAY_WORKSPACE_DEFAULT_STORAGE_SIZE`. The live TOML contains
`acp-hypershell-gp3` and `2Gi` in `[openshell.drivers.kubernetes]`.
ACP rejects these misplaced request fields at startup with configuration
guidance. The invalid live request override has been removed.

ACP control plane `33b69273` is Ready with zero restarts. Its project and session
watch streams connected at 17:13:51 UTC on 2026-09-09. Hypershell control plane
`1375696` is Ready with zero restarts. API images are unchanged. The corrected
gateway and console remain Pending for memory, and the ACP UI remains paused.
No sandbox has executed. All live rows in the approval checklist remain open.
