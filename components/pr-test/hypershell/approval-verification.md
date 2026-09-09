# Approval verification

This checklist preserves the scope of the Hypershell resource assessment.
The Haiku path is ready for user testing. Final approval still requires the
remaining distinct-model check, which the current Vertex policy blocks. Local
tests establish component behavior; they do not prove the deployed path.

Use the explicit jshell context from the deployment README. Use only the test
ACP and Hypershell resources. Record IDs, image digests, request status codes,
and sanitized results. Do not record credential values, request authorization
headers, browser cookies, or raw database test logs.

## Current evidence

The [deployment record](jshell-evidence.md) contains exact image revisions and
completed infrastructure checks. Both APIs and control planes run. ACP service
TLS, authenticated watch streams, database storage, encrypted credential storage,
and browser login were checked. Four workers are Ready, and the UI runs. Native
sandbox commands, security controls, account recovery, and cleanup passed.
A real Haiku task returned its reply through ACP and wrote the verified file.

The prepared Haiku and Sonnet sessions have separate agents and credential IDs.
Both credential records currently contain the same user ADC identity. This
setup can test model selection and record selection, but it cannot by itself
prove isolation between different credential values or cloud identities.

## Required live checks

| Check | Required action and result | State |
| --- | --- | --- |
| Sandbox admission | Verify the pinned driver's service account, SCC, root startup, capabilities, storage, and image pull access. Record the complete pod security context and its difference from ACP's restricted containers. | Passed; native process controls checked |
| Two workspaces | Create a second ACP workspace. Each workspace must have exactly one distinct Hypershell gateway and its own protected gateway credential. | Passed |
| Gateway connection | Use the published HTTPS endpoint and gateway account. Create a sandbox, run a command, upload a payload, read logs, and delete the sandbox. No gateway Kubernetes credentials may be required by ACP. | Passed: native create, command, payload upload, logs, and delete |
| Real runner | Run a real agent, send a message, and receive its result through ACP. Verify that the runner has neither the Hypershell management secret nor a gateway admin secret. | Passed: real reply, file, and actual process secret checks |
| Concurrent inference | Run Haiku and Sonnet together in distinct session workspaces. Inspect the native inference routes and verify both results. | Blocked for Sonnet by Vertex organization policy; concurrent Haiku sessions pass |
| Exact credential selection | Verify each native provider maps to its selected ACP credential ID. Use different credential values, or a controlled invalid credential in one session, to show that the other session is unaffected. Do not claim separate cloud identities from the current ADC copies. | Passed: invalid B did not affect A; B recovered after secret update |
| Credential rotation | Change one selected secret without changing its provider settings. Confirm convergence and an actual runtime request with the new value. Confirm that other session providers do not change. | Passed: same credential/provider IDs, real replies, stable resource version |
| Credential revocation | Remove one required binding or revoke its credential. Confirm the affected session stops and its old runtime access is rejected. Confirm the other session still works. | Passed: native stop, unexpired access denied, bootstrap exchange 403, A still answered |
| Token and account expiry | Verify short-lived gateway token renewal and rejection after expiry. Verify account replacement before expiry, invalidation of the old account, and recovery if the one-time secret response is lost. | Passed; failure states used controlled API setup |
| Cross-boundary denial | A user from one workspace must not access the other workspace's session, logs, files, or credentials. A runner token must not access another session or an old execution generation. | Passed: human, native gateway, and scoped runner access; revoked capabilities and old unexpired generation denied |
| Lost creation response | Interrupt the caller after a remote create succeeds but before ACP records the response. Reconciliation must adopt one resource through the external reference and must not create a duplicate. | Passed: remote201 discarded before headers, CP restarted, original gateway adopted |
| ACP restart during launch | Replace the test control-plane pod during launch. Verify one runner process for the stored generation, no repeated initial task, and delivery of queued messages after recovery. | Passed: one runner process, stable generation, two queued replies once and in order |
| Hypershell outage | Stop only the isolated test Hypershell API for a bounded test, then restore it. ACP must retain resource identity, report pending work, and recover without duplicates. | Passed for gateway identity and project cleanup |
| Endpoint and certificate change | Change only a test gateway endpoint or certificate through its owner. Verify connection refresh, trusted TLS, and rejection of an untrusted endpoint. | Passed: endpoint refresh, certificate serial/SAN change, invalid IP rejection; CA root rotation not tested |
| Stop and resume | Write a file and record its digest. Stop through the native sandbox lifecycle, resume, and verify the same file, retained artifacts, and correct message sequence. | Passed: same runtime IDs, exact file digest, saved cursor76, replies80/84 |
| Cleanup during an outage | Request session and workspace deletion while the remote service is unavailable. State must remain pending. After recovery, verify sandbox, providers, session workspace, gateway accounts, gateway namespace, and owned storage cleanup. | Passed: session/provider/workspace and project/account/credential/storage removed after recovery |
| Snapshots and user operations | Read policy and logs, use supported file/terminal/proxy operations, then stop or delete. Verify retained policy/log snapshots and that failures do not falsely report cleanup success. | Passed: API/native operations and snapshots; browser binary file matched all 4096 bytes and denied anonymous write |
| All session entry points | Create sessions through UI, CLI, SDK, agent start, and schedule. Each must use the same managed binding path. | Passed: UI, CLI, Go SDK, agent start, and actual schedule timer |
| User approval | Restore the ACP UI. Leave a ready workspace and usable session. Supply the HTTPS URL, username, private password file location, and the completed evidence record. | Passed: fresh login, binary file test, same saved session resumed with a 24-hour timeout and fresh reply |

## Existing local coverage

Managed runtime tests cover durable binding, ownership checks, lost create
responses, runner generation checks, pending stop state, and workspace deletion
ordering. Provider tests cover selected IDs, separate provider names, rotation,
revocation, refresh retries, structured profiles, and settings that require a
restart. Snapshot tests cover finite log capture, empty logs, missing sandboxes,
failed requests, and concurrent phase changes. Runner tests cover one process
per generation, message cursor persistence, and cross-session cursor rejection.

API integration tests cover service-only runtime updates, version checks,
read-only user fields, tombstones, and credential access. The UI audit has three
completed passes. SDK and CLI checks cover the new public runtime fields and
service operations. These results are prerequisites for the live checklist,
not substitutes for it.

## Sandbox security boundary

The selected native OpenShell topology is `combined`. It starts the supervisor
and workspace-copy init container as UID 0. The agent container requests
`SYS_ADMIN`, `NET_ADMIN`, `SYS_PTRACE`, and `SYSLOG`. This topology does not set
all of ACP's restricted-container controls. Its AppArmor setting is
`Unconfined`; pod user namespaces are not enabled in the current configuration.
See the pinned [Kubernetes driver source](https://github.com/opendatahub-io/openshell/blob/681c9b2d8b9887f230cee4871bdbdbc9a362dfc8/crates/openshell-driver-kubernetes/src/driver.rs).

Hypershell already grants the dedicated `openshell-gateway-sandbox` service
account access to the existing `privileged` SCC. A subject review of the
expected security context passed for that account and failed for `default`.
The live sandbox was admitted with this account and SCC. No SCC rule was changed.
The runner image pull grant now uses the configured sandbox account; the old
`default` account grant was removed.

The native sandbox therefore differs from the restricted ACP service pods.
Native command probes confirmed the workload privilege drop, filesystem
isolation, seccomp, and Landlock support. A denied network request has a matching
OPA denial in the native OCSF log. The
sidecar topology is not a direct restricted-SCC replacement: it still needs
root init containers and elevated capabilities. Changing topology also changes
some process-policy behavior and needs separate validation.
