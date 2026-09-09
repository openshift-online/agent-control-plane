# jshell deployment evidence

This record covers infrastructure preparation. ACP session approval tests are
still required. All cluster commands used this explicit context:

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
`admin`, `developer`, and `platform-admin`. There is no `johnsell` realm user.
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
The fourth worker remains the blocker for gateway database scheduling.


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
