# Hypershell Integration Work State

The approved goal is an ACP PR with a verified Hypershell and ACP deployment on
the jshell cluster. The assessment is on branch
`docs/hypershell-resource-assessment`, commit `d55ad69a`.

Deployment context: `default/api-jshell-8u58-p3-openshiftapps-com:443/johnsell`.
Always pass this context explicitly. Do not use the global active context.

ACP worktree: `/home/jsell/code/acp-hypershell-integration`.
Hypershell worktree: `/home/jsell/code/hypershell-acp-integration`.

| Work | Owner | State |
|---|---|---|
| ACP schema, runtime controller, providers, recovery | Root agent | In progress |
| Hypershell caller-scoped external reference | hypershell_binding | In progress |
| Cluster inspection and deployment assets | deployment_prepare | In progress |
| Session-scoped runner identity | runner_identity | In progress |
| UI, CLI, SDK, integration verification, PR | Root agent | Pending |

API contract: Project and Session runtime fields are read-only to users. The
control plane uses authenticated runtime endpoints. Runtime inventory includes
soft-deleted records so cleanup can recover after an outage. Gateway secrets
use ACP's encrypted credential store. No secret value is stored in runtime
fields. Each session uses its own OpenShell workspace.

Session protobuf tags reserved for this work: gateway_id 35, gateway_workspace
36, sandbox_id 37, sandbox_name 38, runtime_backend 39, runner_generation 40.
UpdateSessionStatusRequest reserves sandbox_name 18 and runner_generation 20.

The active login initially pointed to hypc-aws-01. A valid jshell login was then
found and verified. No deployment was made to hypc-aws-01.
