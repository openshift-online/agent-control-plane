# Hypershell Integration Work State

The approved goal is an ACP PR with a verified Hypershell and ACP deployment on
the jshell cluster. The assessment is on branch
`docs/hypershell-resource-assessment`, commit `d55ad69a`.

Use deployment context `default/api-jshell-8u58-p3-openshiftapps-com:443/johnsell`
explicitly. Do not use the global active context.

ACP worktree: `/home/jsell/code/acp-hypershell-integration`.
Hypershell worktree: `/home/jsell/code/hypershell-acp-integration`.

| Work | State |
|---|---|
| API runtime fields, tombstones, version checks, and service access | Implemented and tested |
| Hypershell external references and deletion confirmation | Implemented and tested |
| Gateway accounts, encrypted ACP credentials, and managed transport | Implemented; live gateway preparation in progress |
| Session workspaces, provider selection, runner identity, and cleanup | Implemented; full control-plane tests pass |
| Legacy runner identity and TLS callbacks | Implemented and tested |
| UI, CLI, and SDK changes | Implemented; all three UI audit passes complete |
| Hypershell and ACP deployment | APIs and databases ready; gateway awaits capacity |
| Live session, isolation, rotation, recovery, and cleanup tests | Pending |
| PRs | ACP #482 and Hypershell #260 open as drafts |
| User approval deployment | Pending worker capacity and live proof |

API contract: Project and Session runtime fields are read-only to users. The
control plane uses authenticated runtime endpoints. Runtime inventory includes
soft-deleted records so cleanup can recover after an outage. Gateway secrets
use ACP's encrypted credential store. No secret value is stored in runtime
fields. Each session uses its own OpenShell workspace.

Project runtime protobuf fields use tags 8 through 19. Session runtime fields
use tags 35 through 46. Session phase updates use a version check and an expected
phase. The control plane persists a runner generation before execution. Runner
access is limited to that active session and generation.

The active login initially pointed to hypc-aws-01. A valid jshell login was then
found and verified. No deployment was made to hypc-aws-01.

The deployment uses namespaces `acp-hypershell` and `acp-hypershell-system`.
Workspace `jshell-hypershell-test` has a `project:owner` grant for `johnsell`.
Private deployment configuration and credentials are in the local directory
`/home/jsell/.cache/acp-hypershell-jshell`, with restricted file permissions.
Do not copy credential values or raw database test logs into review artifacts.

The CSI driver IAM role was absent. The deployment restored the role with the
cluster's OIDC subjects and the ROSA EBS CSI policy. A restricted test pod wrote
and read a file from a new PVC. The test pod and PVC were then removed.

ACP's public gRPC route uses a dedicated certificate and passthrough TLS.
Certificate verification and HTTP/2 negotiation passed. Authenticated service
reflection passed; requests without authentication were rejected. The API uses
the framework's enhanced TLS configuration for both REST and gRPC. TLS automatic
Kubernetes detection is disabled because it selects an unsuitable configuration.

The cluster has three workers. The gateway database is ready. The gateway and console cannot yet schedule.
The current OCM identity cannot change this worker pool. The user has been asked
to increase the worker count from three to four. Resource requests for the new
services are also being checked against measured use.

Validation completed before live session tests:

- Full control-plane Go tests.
- API integration tests for projects, sessions, credentials, and access control,
  with local PostgreSQL test containers.
- Full CLI Go tests and TypeScript SDK tests.
- Two Python SDK runtime contract tests.
- UI TypeScript checks and all 446 UI tests.
- Earlier runner, token exchange, transport, and provider tests recorded in commits.

API lint and new-code control-plane lint pass. Full control-plane vet passed.
The control plane retains unrelated baseline lint findings. These checks do not
replace the pending live session tests.

The runner saves its accepted message sequence in its persistent workspace.
Startup uses the API task record once. Project, agent, and inbox instructions
are passed as SDK system context. The control plane saves policy and log
snapshots before it stops or deletes a sandbox.

Provider secret rotation can update a running session. A change to provider
settings requires a session restart. The provider settings hash excludes secret
values. Runner startup preserves the proxy and CA settings from OpenShell.

The UI is temporarily scaled to zero to release memory for the gateway database.
It must be restored before the deployment is ready for user approval.

ACP draft PR: https://github.com/openshift-online/agent-control-plane/pull/482.
Hypershell draft PR: https://github.com/openshift-online/hypershell/pull/260.

The deployed ACP control plane uses `c8ac1505`; its API, UI, and runner images
use `95264f99`. The deployed Hypershell API uses `e66e994`, and its control plane
uses `05abc20`. See the deployment evidence for image digests. Both APIs and
control planes are ready. The UI remains paused. The corrected gateway remains
Pending because another workload used the memory released by its failed
replica. No live sandbox has run. A fourth worker is the remaining prerequisite
for live verification; the current OCM login cannot change this worker pool.
