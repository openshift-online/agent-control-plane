# jshell deployment evidence

ACP and Hypershell run on jshell. Two ACP workspaces have separate managed
OpenShell gateways. Native sandbox execution, account recovery, image access,
and resource cleanup pass. A real Haiku agent task returned its result through
ACP. All live checklist items pass except concurrent distinct-model inference,
which the current Vertex organization policy blocks. The deployment is ready
for user testing; both PRs remain drafts for final approval.

ACP review: [PR 482](https://github.com/openshift-online/agent-control-plane/pull/482).
Hypershell review: [PR 260](https://github.com/openshift-online/hypershell/pull/260).
Both PRs remain drafts. The [approval checklist](approval-verification.md)
separates completed checks from work that remains.

All cluster commands use this explicit context:

`default/api-jshell-8u58-p3-openshiftapps-com:443/johnsell`

## Access and resources

- ACP namespace: `acp-hypershell`.
- Hypershell namespace: `acp-hypershell-system`.
- [ACP UI](https://ambient-ui-acp-hypershell.apps.rosa.jshell.8u58.p3.openshiftapps.com).
- [ACP API](https://ambient-api-server-acp-hypershell.apps.rosa.jshell.8u58.p3.openshiftapps.com).
- [Hypershell API](https://hypershell-api-acp-hypershell-system.apps.rosa.jshell.8u58.p3.openshiftapps.com).

Browser login as `johnsell` passes. The password is in the private local file
`/home/jsell/.cache/acp-hypershell-jshell/johnsell-password`.
The private directory has mode `0700`; secret files have mode `0600`.
No secret values are in this record.

To test the deployment, sign in as `johnsell` and open
`jshell-hypershell-test`. Open session `3J6PgDamt4dr2yiSE23p4J5oKP6`
and send a task. The file browser can read `artifacts/proof-haiku.txt`.
Create another session with agent `proof-haiku` to test sandbox creation.
Stop and resume that session to test file retention. The isolation workspace
is intentionally outside this user's access.

The user set the worker pool to minimum 2 and maximum 5. Four workers are now
Ready. The ACP UI is restored to one replica. ACP API, control plane, UI, and
PostgreSQL run. The isolated Hypershell API, controller, and PostgreSQL run.
The existing shared Hypershell deployment was not upgraded.

| ACP workspace | Hypershell gateway | Gateway namespace |
| --- | --- | --- |
| `jshell-hypershell-test` | `3J6BJgdqGcVTB92p3JCnhkgfkEn` | `openshell-13839a239b6b75e9` |
| `jshell-hypershell-isolation` | `3J6KeRMk26HLednvmeaNQ3tYoUP` | `openshell-8500c12862caa9f7` |

Each project has its own protected ACP gateway credential. Gateway accounts
can change during recovery; the project binding is the source of the current
account ID. ACP uses the Hypershell API and the native gateway API. It has no
Kubernetes permission to create gateway namespaces or sandbox workloads.

## Deployed images

| Image | Source commit | SHA-256 digest |
| --- | --- | --- |
| ACP API | `1766447c` | `b14b768705dcce79182e363259adffe36cdb4cbc1f79c32e61a406468f756324` |
| ACP control plane | `452f67ae` | `84b324fb68ac7d6b905071721b6e62f3223de45162e6bdb1898f1c7072768c50` |
| ACP UI | `a19e04ee` | `c1b5697d25101b6897fbd3abcf7fbc098a666ce2b486ec99049fdbb864f4235c` |
| ACP runner | `391c060d` | `e5d4b6bd42f3e3bc08a15d62126b301251fc74f48058d16d89d8f45642531169` |
| Hypershell API | `1d8fba4` | `a3ccf2d4f71365469de38046a6529b0649de64aa0b3af3def4cc53186a106213` |
| Hypershell control plane | `bf99d06` | `1540f37ecf29274c013ad604dec86de2f911e6f2f38cede743ab950afbc5722b` |

Builds use a Git archive of the stated commit. This table records deployed images and the configured runner image. Existing
sandboxes retain the image used at creation. The current main session was
created with the configured `391c060d` runner image.
The native gateway is `quay.io/opendatahub/odh-openshell-gateway:v0.0.109-rhaiv.0`
at digest `a80b79e514826e8d57ea137749cf18a6e7f3d92e26bfefe005f3a9c4a55b8bdd`.
Its source revision is `681c9b2d8b9887f230cee4871bdbdbc9a362dfc8`.

## Authentication and TLS

ACP browser and machine clients use the existing `hypershell` Keycloak realm.
The isolated Hypershell uses `hypershell-acp-jshell`. Its bootstrap script
preserves client secrets on repeat runs. The provisioner has client and user
management roles only in the isolated realm.

Realm separation prevents the older shared Hypershell instance from treating
this instance's gateway clients as orphans. The new Hypershell API also checks
local account and gateway ownership before orphan cleanup. The two proof
gateways were reconciled through the normal API to use the isolated issuer.

The ACP API stores credentials encrypted. Repeat deployment preserves the
database password, encryption keyring, runner signing keys, and UI session key.
The API has only the runner public key. The controller uses a separate
Hypershell manager identity.

Verified HTTPS and gRPC work from the operator host. Public gRPC uses a
passthrough Route and a dedicated certificate with public and internal DNS
names. The CA private key stays in cert-manager. ACP receives public roots only.
REST uses a reencrypt Route. Project and session watch streams connect over TLS.

Native gateway authentication passes with TLS 1.3 and HTTP/2. Anonymous requests
fail with `UNAUTHENTICATED`. Account A cannot use gateway B, and account B cannot
use gateway A. Gateway tokens last 300 seconds. The same account obtains a new
token without replacement. The old token was rejected 62 seconds after expiry;
a probe 47 seconds after expiry was still accepted within the verifier's grace.

Account recovery tests passed. A controlled setup left a remote account whose
one-time secret was not stored in ACP. Reconciliation removed it. A separately
bound account near expiry was replaced; its encrypted ACP credential was
removed. Retired client secrets returned HTTP 401. The replacement account
passed native gateway authentication. These tests used explicit API setup to
construct the failure states; they did not inject a network packet loss.

The current user boundary check signed in as `johnsell`. The owned project
returned HTTP 200. The isolation project and both gateway credential metadata
and token endpoints returned HTTP 404. Service requests confirmed each tested
resource existed before and after these denials. The later live check also denied isolation session, log, and file access.
A temporary `project:viewer` grant allowed reads but denied direct control-plane
file writes and task stops with HTTP 403. The denied write created no file.
Removing that grant restored cross-project denial. A file whose name contained
spaces and `#` retained its bytes through the API and native-backed proxy.
All temporary grants and file fixtures were removed.

The final UI image passed a signed-in browser binary transfer. Upload and
download preserved all 4,096 bytes, including every byte value. The SHA-256 was
`c8f5d0341d54d951a71b136e6e2afcb14d11ed8489a7ae126a8fee0df6ecf193`.
An anonymous write returned HTTP 401 and left the file unchanged. Normal browser
deletion removed the fixture; the next GET returned HTTP 404. All 456 UI tests,
TypeScript, focused lint, and the production build pass. The final source
review confirmed the exact native route permissions and binary proxy fix.

## Sandbox and storage checks

Native sandbox creation, command execution, stop, and deletion pass. The native
workspace and sandbox names fit the pinned driver's 19-character limit. The
runner image is selected through `OPENSHELL_RUNNER_IMAGE`. Source files remain
readable by an arbitrary OpenShift UID after archive and image build.

The native `combined` topology uses the dedicated
`openshell-gateway-sandbox` service account and the existing privileged SCC.
It needs root supervisor startup and elevated capabilities. It differs from
ACP's restricted service pods. No SCC rule was changed.

Inside a native command process, the observed UID and GID were `1000980000`.
All capability sets were zero. `NoNewPrivs` was 1, and seccomp was active.
The RHEL kernel reports Landlock ABI 6. `memfd_create` and the kernel uevent
netlink socket returned `EPERM`. Reading the world-readable
`/sys/kernel/uevent_seqnum` and creating a file in `/var/tmp` returned `EACCES`.
The native policy uses best-effort Landlock; these results do not establish
fail-closed behavior on a kernel without the required support.
A Python request to `example.com:443` failed. The matching native OCSF log
recorded `DENIED`, engine `opa`, and an endpoint-not-allowed reason.

A fresh temporary ACP workspace proved automatic private runner image access.
A new image configuration digest forced a pull. The configured sandbox account
could pull only the named runner image. The default account, another image,
and ACP Secret listing were denied. Deleting the generated image RoleBinding
caused Hypershell to restore it with a new UID.

Normal API deletion removed the temporary sandbox, native workspace, gateway,
gateway and database namespaces, image RoleBinding, and PVC-backed volumes.
No manual resource cleanup was needed. Two failed runner attempts also passed
normal ACP stop/delete cleanup. Their native sandbox and workspace lookups
returned `NOT_FOUND`, and their pods and PVCs were removed.

Log snapshots now accept up to 2 MiB per document while ordinary credential
settings retain their smaller limit. A live failed session retained 52,600
bytes of logs and 6,158 bytes of policy. Capture preserves the full policy and
bounds logs by retaining recent entries with an omission count.

Gateway database and workspace storage use `acp-hypershell-gp3`. Workspace PVCs
request 2Gi. These are gateway-wide driver settings. Per-sandbox requests do not
accept storage-class or default-size fields.

A bounded outage test stopped only the isolated Hypershell API. Its Route
returned HTTP 503. A temporary ACP project deletion stayed pending for the
15-second observation interval. The API was restored to one ready replica.
Normal cleanup then removed the gateway and database namespaces, image pull
grant, PVC-backed volume, and protected ACP credential. The main project kept
the same gateway, account, and credential before, during, and after the outage.

A second fault test discarded a successful remote gateway creation response
before ACP received its headers. Hypershell had created gateway
`3J6SXn3YeM5tQyYYsC1SLIFH4a4`. ACP stored the external reference but no gateway,
account, or credential ID. The ACP control plane was replaced while retries
remained blocked. After release, it adopted the same gateway ID and reached
Ready. Normal project deletion completed. The temporary TLS proxy was removed,
the original endpoint was restored, and both existing project bindings and
all configured image references stayed unchanged.

The session cleanup outage test used a separate gateway with a running Haiku
session. Its native API returned `UNAVAILABLE` while the gateway was stopped.
ACP retained the deletion record and runtime IDs through four samples over
20 seconds. After restoration, native sandbox, provider, and workspace lookups
all returned `NOT_FOUND` at 19:00:58 UTC. The main session returned a fresh reply
before and after the outage; both existing sessions kept their identities.

The native delete completed before the restarted gateway's watch began. The
pinned gateway recovered the missed event through its periodic sweep: a
300-second grace period from resource creation, then a 60-second sweep interval.
These values are in the pinned
[compute constants](https://github.com/opendatahub-io/openshell/blob/681c9b2d8b9887f230cee4871bdbdbc9a362dfc8/crates/openshell-server/src/compute/mod.rs#L285-L290).
The measured delay is part of the native recovery contract. ACP kept cleanup
pending through that interval. No source change or manual deletion was needed.
Normal project deletion completed at 19:01:16 UTC. Final checks at 19:01:32
confirmed removal of both namespaces, both volumes, the image pull grant,
source and gateway credentials, agent and binding, gateway account, and
Hypershell gateway/database records. Both ACP deletion records report `Deleted`.

## Agent execution and user testing

The current Haiku session is `3J6PgDamt4dr2yiSE23p4J5oKP6` in
`jshell-hypershell-test`. Its sandbox is
`f81fc82c-b5f3-47a9-a6bb-77d3fece07b8`, in native workspace
`ws-ccayobg2rslgxgck`. Its real task passed. The agent wrote
`/sandbox/workspace/artifacts/proof-haiku.txt` with exactly
`ACP_HYPERSHELL_HAIKU_OK`. Native command execution verified the file, and ACP
stored the assistant reply, tool messages, and 13 task events. The sandbox uses
the configured runner image and has zero pod restarts.

For user testing, the main session was stopped and resumed through ACP with a
24-hour timeout. Its sandbox, workspace, and proof file remained unchanged.
The new execution generation is `c7e5695e85737a6532aec618b7b5e54d`.
A fresh message at sequence 102 received `ACP_APPROVAL_READY` at sequence 104.
The isolation session was then stopped through ACP; native status is `Stopped`.

Live probes found two callback issues: the runner replaced native proxy roots
with ACP roots, and the native TLS proxy did not negotiate HTTP/2 for gRPC.
The committed fixes combine trusted roots and pass encrypted TLS through for
the exact ACP callback endpoints. Clients still verify server certificates.
The deployed callback policy passes HTTP/2 connection checks. The runner
also sent duplicate Authorization headers, which the API rejected. A real TLS
regression test reproduced that failure. Runner `391c060d` sends one header.
The previous session was removed through normal API cleanup before the fresh
image test. The fresh image passed the real agent task.

Direct Vertex access permits Haiku. The current project's organization policy
blocks Sonnet 4.5 and 4.6. The two original model credentials use the same ADC
identity. They do not prove separate cloud identities. A controlled invalid
second credential proved exact record selection, rotation, and revocation.
The separate Sonnet model check needs a project that permits that model.
An additional Opus 4.6 request was blocked by the same policy. Opus 4.5
inference and the older Haiku catalog entry were unavailable in `global`.

The controlled invalid credential test passed. B remained unable to launch
while A answered. Updating B's existing credential ID let B run and return its
reply; A still answered. The native provider ID stayed the same. Mutable source
state now uses reserved `acp.internal/*` provider config keys because native
provider updates ignore metadata changes. Its source version converged, and
the resource version stayed unchanged for a 12-second observation interval.
Removing B's required credential binding stopped its native sandbox. Its
unexpired access token then failed, and its bootstrap exchange returned HTTP
403. Before revocation, the token could read only B's message stream and could
not read A. A still returned a fresh reply with the same runtime identity.

Read-only inspection of the actual runner, web server, Claude, and MCP process
environments found no Hypershell manager secret, gateway account secret,
direct provider secret, ADC file setting, or Kubernetes service-account token
file. Native provider tokens were placeholders. Session capabilities were
present where expected and were not printed.

A stayed Running across the API and control-plane rollouts with the same
sandbox, workspace, and runner generation. Its initial user task and proof-file
write each occurred once.

The CLI and Go SDK each created another managed session with the agent model
inherited. Both returned `ENTRYPOINT_OK` and had one initial user task. The
agent-start route also produced its expected real reply in a separate session.
UI creation as `johnsell` also returned its expected reply with one initial
task and an inherited model. Its browser request omitted the model and returned
HTTP 201. The real timer also created one session at the next scheduled minute. That
session inherited Haiku, had one initial task, returned its expected reply, and
stopped. The schedule was suspended after that run. Tests used normal API
cleanup for their sessions, native workspaces, temporary agents, bindings, and
schedule.

B resumed after its credential binding was restored. Two tasks queued while
it was stopped had sequences 75 and 76. The ACP control-plane pod was replaced
during phase `Creating`. The new runner generation stayed the same across the
replacement, and exactly one runner web-server process remained. Replies 80
and 84 arrived once, in order. The saved cursor was 76. The sandbox and native
workspace IDs stayed the same. The retained file still contained exactly
`ACP_B_PERSISTENCE_OK`, with SHA-256
`dc7d40f335e9d62ae40ab9f0dce1a5ccf50e0d574bd79dd56d6aa4e19ef68c54`.
The previous generation's unexpired bootstrap token returned HTTP 403.

The gateway endpoint test changed B's published route to its internal service
name. ACP connected through verified TLS. An IP endpoint without a matching
certificate SAN failed. A normal certificate renewal changed its serial and
added a test SAN; ACP connected to that name after renewal. The external
endpoint and original effective SAN list were restored, and the temporary
network rule was removed. The account and credential IDs stayed the same.
This proves certificate renewal, not CA root rotation.

See the approval checklist for restart, outage, and retained-file evidence.
The remaining Sonnet test needs a project that permits the model.

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

## Review and test status

The final code revision is `c9cb00a4`; later commits update this evidence only.
The mechanical PR review gate passes. CodeRabbit CLI was unavailable, so that
optional review was skipped. Independent source review found two proxy defects;
both fixes passed regression tests and live verification. API tests used
PostgreSQL with role authorization enabled. Control-plane tests, race checks,
vet, compatible lint, runner TLS/identity tests, and CLI/SDK checks pass.
GitHub and Konflux checks continue on pushes; this record does not claim that
all external checks pass.
