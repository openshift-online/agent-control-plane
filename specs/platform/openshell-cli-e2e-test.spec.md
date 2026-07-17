# OpenShell CLI E2E Test Specification

**Date:** 2026-07-15
**Status:** Design
**Related:** `openshell-sandbox-provisioning.spec.md` — gateway sandbox provisioning; `e2e-test-tooling.spec.md` — mock LLM infrastructure; [ENGPROD-10199](https://redhat.atlassian.net/browse/ENGPROD-10199) — issue
**Skill:** `skills/build/full-stack-pipeline/` — wave-based implementation pipeline

---

## Purpose

Power users who interact with ACP-managed OpenShell gateways via the native `openshell` CLI need a dedicated e2e test validating that all core CLI commands work against ACP-provisioned gateways. Existing e2e tests (`gateway-e2e-test.sh`, `openshell-dual-tenant.sh`) exercise OpenShell integration through the API server and `acpctl`. There is no test that validates the direct `openshell` CLI path — the exact workflow a power user would follow in the "OpenShell as a Service" story.

This spec defines an e2e test script that authenticates to an ACP-managed OpenShell gateway using the `openshell` CLI and exercises the sandbox, provider, policy, and settings command groups. The test validates that resources created via `openshell` CLI are visible and consistent, and that the gateway deployed by ACP behaves identically to a standalone OpenShell deployment from the CLI's perspective.

### Scope

- E2e test script at `tests/e2e/openshell-cli-e2e.sh` with built-in demo-style verbose output
- CLI-only testing: sandbox ops, provider ops, policy ops, settings ops
- Gateway connectivity setup via mTLS certificate extraction from the `openshell-server-tls` secret
- Optional cross-validation between `openshell` CLI state and cluster state (via `--cluster-validate`)
- Test fixtures at `tests/e2e/fixtures/openshell-cli-test/`

### Out of Scope

- Testing the `openshell` CLI build/installation — the binary is assumed available
- Testing OpenShell gateway deployment — that is covered by gateway provisioning specs
- Inference routing validation (already covered by `gateway-e2e-test.sh` mock LLM flow)

Some overlap with `gateway-e2e-test.sh` is acceptable when the coverage is `openshell`-specific — for example, verifying that a policy applied via `openshell policy set` actually enforces network restrictions inside the sandbox. The distinction is that this test exercises the `openshell` CLI path, not the `acpctl`/API path.

### Dependencies

- `openshell` CLI binary available in the test environment (CI installs it via `local-dev-simulation`; local runs SHALL error if missing)
- `acpctl` CLI built and available (`make build-cli`)
- Kind cluster provisioned via `make kind-up` with `OPENSHELL_USE_GATEWAY=true`

---

## Requirements

### Requirement: Test Script Structure

The test SHALL be a self-contained bash script at `tests/e2e/openshell-cli-e2e.sh` that follows the conventions established by `gateway-e2e-test.sh` and `openshell-dual-tenant.sh`.

The script SHALL:
- Use `set -euo pipefail` for strict error handling
- Implement `pass()`, `fail()`, `skip()`, and `section()` helper functions with pass/fail counters
- Implement a `run_cmd()` helper that prints each command in orange `$ ...` text with `▶` markers, executes it, and displays indented output before asserting pass/fail — serving as both a test harness and a human-readable demo
- Use `sep()` separator lines and cyan `━━` section banners for visual structure
- Print an intro banner showing tenant, API URL, and sandbox image
- Accept `--skip-cleanup` flag for post-mortem inspection
- Accept an optional `API_URL` positional argument (default: `http://localhost:<port-forward>`)
- Set up a port-forward to the API server
- Register the gateway with the `openshell` CLI via mTLS certificate extraction from the `openshell-server-tls` Kubernetes secret and `openshell gateway add --local`
- Wrap `sandbox create` in `timeout 60` to prevent CI hangs
- Report per-section results with a styled pass/fail summary footer
- Exit non-zero if any test fails
- Clean up all resources created during the test, even on failure (via trap)

The test SHALL organize assertions into numbered sections by command category:
1. Prerequisites (CLI availability, token, port-forwards)
2. Gateway connectivity (registration, health check)
3. Sandbox operations (create, list, get, delete)
4. Provider operations (create, get, list, delete)
5. Policy operations (set, get, list, delete)
6. Settings operations (get, set, delete)
7. Cross-validation (optional, requires `--cluster-validate`)
8. Cleanup

#### Scenario: Test runs on a fresh Kind cluster

- GIVEN `make kind-up` has completed with `OPENSHELL_USE_GATEWAY=true`
- AND the `openshell` CLI is installed and available in `$PATH`
- WHEN `./tests/e2e/openshell-cli-e2e.sh` is executed
- THEN the test SHALL complete with all sections reporting pass or skip (no fail)
- AND all created resources SHALL be cleaned up

#### Scenario: Test is idempotent

- GIVEN a Kind cluster where the test has already run
- WHEN `./tests/e2e/openshell-cli-e2e.sh` is executed again
- THEN the test SHALL pass without errors from leftover state

#### Scenario: openshell CLI missing — error in local, install in CI

- GIVEN the `openshell` CLI is not installed
- WHEN the test script starts
- THEN it SHALL print a clear message indicating the CLI is required and exit with a non-zero code
- AND in CI (`local-dev-simulation` pipeline), the `openshell` CLI SHALL be installed as a prerequisite step before the test runs

### Requirement: Gateway Connectivity via mTLS Certificate Extraction

The test SHALL authenticate to an ACP-managed OpenShell gateway by extracting the mTLS client certificate from the `openshell-server-tls` Kubernetes secret in the tenant namespace and registering the gateway via `openshell gateway add --local`. This approach validates the direct gateway connectivity path available to a power user with cluster access.

The gateway registration SHALL:
1. Wait for the `openshell-server-tls` secret to appear in the `tenant-a` namespace (certgen job may still be running)
2. Extract `tls.crt` and `tls.key` from the secret and write them to temporary files
3. Set up a `kubectl port-forward` to the gateway StatefulSet
4. Register via `openshell gateway add --name <gateway> --local https://localhost:<port> --cert <cert> --key <key> --insecure`
5. Verify connectivity via `openshell sandbox list --gateway <gateway>`

#### Scenario: Gateway registration succeeds via mTLS cert extraction

- GIVEN an ACP-managed OpenShell gateway is running in the `tenant-a` namespace
- AND the `openshell-server-tls` secret contains valid mTLS certificates
- WHEN the test extracts certs and runs `openshell gateway add --local`
- THEN the command SHALL register the gateway with the `openshell` CLI
- AND `openshell sandbox list --gateway <gateway>` SHALL return without error

#### Scenario: Gateway TLS secret not found

- GIVEN the `openshell-server-tls` secret does not exist in the tenant namespace
- WHEN the test waits for the secret
- THEN after the timeout it SHALL fail with a clear message
- AND the test SHALL skip gateway-dependent sections

### Requirement: Sandbox Operations

The test SHALL exercise the full sandbox lifecycle using the `openshell` CLI against an ACP-managed gateway.

#### Scenario: Sandbox create

- GIVEN a registered gateway `tenant-a`
- WHEN the test runs `timeout 60 openshell sandbox create --gateway <gateway> --from <runner-image> --no-tty -- echo ready`
- THEN the command SHALL succeed within 60 seconds
- AND it SHALL return a sandbox name or identifier
- AND the sandbox SHALL appear in `openshell sandbox list --gateway tenant-a`

#### Scenario: Sandbox list

- GIVEN a sandbox has been created via `openshell sandbox create`
- WHEN the test runs `openshell sandbox list --gateway tenant-a`
- THEN the output SHALL include the created sandbox
- AND the output SHALL show the sandbox's phase (e.g., PROVISIONING, READY)

#### Scenario: Sandbox get

- GIVEN a sandbox exists with name `<sandbox-name>`
- WHEN the test runs `openshell sandbox get --gateway tenant-a --name <sandbox-name>`
- THEN the output SHALL include the sandbox's details (name, phase, image)

#### Scenario: Sandbox exec

- GIVEN a sandbox is in READY phase
- WHEN the test runs `openshell sandbox exec --gateway tenant-a --name <sandbox-name> -- echo hello`
- THEN the command SHALL succeed
- AND the output SHALL contain `hello`

#### Scenario: Sandbox delete

- GIVEN a sandbox exists with name `<sandbox-name>`
- WHEN the test runs `openshell sandbox delete --gateway tenant-a --name <sandbox-name>`
- THEN the command SHALL succeed
- AND the sandbox SHALL no longer appear in `openshell sandbox list --gateway tenant-a`

#### Scenario: Sandbox readiness polling

- GIVEN a sandbox has just been created
- WHEN the test polls `openshell sandbox get --gateway tenant-a --name <sandbox-name>`
- THEN it SHALL poll every 2 seconds with a timeout of 120 seconds
- AND the sandbox SHALL transition through PROVISIONING to READY within the timeout
- AND if the timeout expires, the test SHALL fail with a diagnostic message including sandbox phase and pod status

### Requirement: Provider Operations

The test SHALL exercise provider lifecycle using the `openshell` CLI. Providers in OpenShell map to credential sources that inject environment variables into sandboxes via the egress proxy.

#### Scenario: Provider create

- GIVEN a registered gateway `tenant-a`
- WHEN the test runs `openshell provider create --gateway tenant-a --name test-provider --type generic --credential-key TEST_KEY --credential-value test-value`
- THEN the command SHALL succeed
- AND the provider SHALL appear in `openshell provider list --gateway tenant-a`

#### Scenario: Provider get

- GIVEN a provider `test-provider` exists on the gateway
- WHEN the test runs `openshell provider get --gateway tenant-a --name test-provider`
- THEN the output SHALL include the provider's name and type

#### Scenario: Provider list

- GIVEN one or more providers exist on the gateway (including ACP-created providers from session provisioning)
- WHEN the test runs `openshell provider list --gateway tenant-a`
- THEN the output SHALL include all providers in the namespace
- AND ACP-created providers (e.g., from `setup-kind-openshell.sh`) SHALL be visible alongside test-created providers

#### Scenario: Provider delete

- GIVEN a provider `test-provider` exists on the gateway
- WHEN the test runs `openshell provider delete --gateway tenant-a --name test-provider`
- THEN the command SHALL succeed
- AND the provider SHALL no longer appear in `openshell provider list`

### Requirement: Policy Operations

The test SHALL exercise the sandbox policy lifecycle using the `openshell` CLI. Policies control network egress, filesystem access, and process restrictions within sandboxes.

#### Scenario: Policy set

- GIVEN a sandbox is in READY phase with name `<sandbox-name>`
- WHEN the test runs `openshell policy set --gateway tenant-a --name <sandbox-name> --file <policy-file>`
- THEN the command SHALL succeed
- AND the applied policy SHALL be retrievable via `openshell policy get`

#### Scenario: Policy set — idempotent repeat

- GIVEN a policy has already been set on a sandbox
- WHEN the test runs `openshell policy set` again with the same policy file
- THEN the command SHALL succeed (idempotent)
- AND the policy version SHALL increment

#### Scenario: Policy get

- GIVEN a policy has been set on sandbox `<sandbox-name>`
- WHEN the test runs `openshell policy get --gateway tenant-a --name <sandbox-name>`
- THEN the output SHALL include the policy's network rules, filesystem rules, and version

#### Scenario: Policy list

- GIVEN one or more sandboxes have policies set
- WHEN the test runs `openshell policy list --gateway tenant-a`
- THEN the output SHALL include policies for all sandboxes with configured policies

#### Scenario: Policy enforcement — allowed endpoint reachable

- GIVEN a policy has been set on sandbox `<sandbox-name>` allowing `update.code.visualstudio.com:443` for `/usr/bin/curl`
- WHEN the test runs `openshell sandbox exec --gateway tenant-a --name <sandbox-name> -- curl -s https://update.code.visualstudio.com`
- THEN the request SHALL succeed (HTTP response received, no `policy_denied`)

#### Scenario: Policy enforcement — blocked endpoint denied

- GIVEN a policy has been set on sandbox `<sandbox-name>` allowing only `update.code.visualstudio.com:443`
- WHEN the test runs `openshell sandbox exec --gateway tenant-a --name <sandbox-name> -- curl http://example.com`
- THEN the response SHALL contain `policy_denied` or the request SHALL fail
- AND the sandbox's egress proxy SHALL have blocked the request

#### Scenario: Policy delete

- GIVEN a policy has been set on sandbox `<sandbox-name>`
- WHEN the test runs `openshell policy delete --gateway tenant-a --name <sandbox-name>`
- THEN the command SHALL succeed
- AND `openshell policy get` SHALL return the sandbox's default policy (not the custom one)

### Requirement: Settings Operations

The test SHALL exercise the gateway settings lifecycle using the `openshell` CLI. Settings control gateway-wide and per-sandbox configuration.

#### Scenario: Settings set — global

- GIVEN a registered gateway `tenant-a`
- WHEN the test runs `openshell settings set --gateway tenant-a --global --key test_setting --value test_value`
- THEN the command SHALL succeed
- AND the setting SHALL be retrievable via `openshell settings get`

#### Scenario: Settings get — global

- GIVEN a global setting `test_setting` has been set
- WHEN the test runs `openshell settings get --gateway tenant-a --global --key test_setting`
- THEN the output SHALL include `test_value`

#### Scenario: Settings set — per-sandbox

- GIVEN a sandbox is in READY phase
- WHEN the test runs `openshell settings set --gateway tenant-a --name <sandbox-name> --key sandbox_test_key --value sandbox_test_value`
- THEN the command SHALL succeed

#### Scenario: Settings get — per-sandbox

- GIVEN a per-sandbox setting `sandbox_test_key` has been set
- WHEN the test runs `openshell settings get --gateway tenant-a --name <sandbox-name> --key sandbox_test_key`
- THEN the output SHALL include `sandbox_test_value`

#### Scenario: Settings delete

- GIVEN a global setting `test_setting` exists
- WHEN the test runs `openshell settings delete --gateway tenant-a --global --key test_setting`
- THEN the command SHALL succeed
- AND subsequent `openshell settings get --global --key test_setting` SHALL indicate the setting is not set

### Requirement: Cross-Validation with Cluster State (Optional)

The test MAY verify that resources created via the `openshell` CLI are consistent with Kubernetes cluster state. This section is gated behind a `--cluster-validate` flag because it requires cluster access (`kubectl`) which is outside the "power user CLI-only" persona this test represents. When the flag is not passed, these assertions SHALL be skipped.

#### Scenario: Cross-validation skipped by default

- GIVEN the test is invoked without `--cluster-validate`
- WHEN the test reaches the cross-validation section
- THEN it SHALL skip all cluster-state assertions with `skip("--cluster-validate not set")`

#### Scenario: CLI-created sandbox visible as Kubernetes resource

- GIVEN `--cluster-validate` is passed
- AND a sandbox was created via `openshell sandbox create`
- WHEN the test queries `kubectl get sandboxes -n tenant-a`
- THEN the sandbox SHALL appear as a Sandbox CRD resource
- AND its phase SHALL match the `openshell sandbox get` output

#### Scenario: CLI-created sandbox pod visible in namespace

- GIVEN `--cluster-validate` is passed
- AND a sandbox is in READY phase (created via `openshell sandbox create`)
- WHEN the test queries `kubectl get pods -n tenant-a`
- THEN a pod corresponding to the sandbox SHALL exist and be in Running phase

#### Scenario: ACP-created providers visible via CLI

- GIVEN ACP has provisioned providers during `make kind-up` (e.g., mock-llm credentials)
- WHEN the test runs `openshell provider list --gateway tenant-a`
- THEN ACP-created providers SHALL appear in the CLI output
- AND their types SHALL match the expected OpenShell provider type mappings

### Requirement: Test Fixtures

The test SHALL use fixture files in `tests/e2e/fixtures/openshell-cli-test/` for policy files and any YAML resources needed during testing.

#### Scenario: Test policy fixture

- GIVEN a policy fixture at `tests/e2e/fixtures/openshell-cli-test/test-policy.yaml`
- THEN the policy SHALL define a minimal sandbox policy with:
  - A single network rule allowing a known test endpoint (e.g., `update.code.visualstudio.com:443`)
  - Filesystem rules matching the standard sandbox layout (`/sandbox`, `/tmp` read-write)
  - Process rules (`run_as_user: sandbox`, `run_as_group: sandbox`)
- AND the policy SHALL be valid for use with `openshell policy set --file`

### Requirement: Verbose Output (Integrated Demo)

Rather than maintaining a separate demo script, the e2e test itself SHALL produce demo-quality output suitable for both CI debugging and live walkthroughs. This is achieved through the `run_cmd()` helper and styled formatting integrated directly into the test script.

The test output SHALL:
- Print each `openshell` CLI command in orange-highlighted `$ <command>` text with a `▶` marker before execution
- Display the first 20 lines of each command's output, indented under the command
- Use cyan `━━` double-line section banners with dim `──────` separator lines between sections
- Use `N · Title` format for section headers (e.g., `3 · Sandbox Operations`)
- Show a styled results footer with separator-bordered pass/fail summary in green (all pass) or red (failures)
- Print an intro banner showing tenant namespace, API URL, and sandbox image

#### Scenario: CI output is debuggable

- GIVEN the test is running in CI
- WHEN a step fails or hangs
- THEN the CI log SHALL show which command was being executed, its output, and the pass/fail result
- AND the `timeout 60` on sandbox create SHALL prevent indefinite hangs

#### Scenario: Test serves as a walkthrough

- GIVEN a developer runs the test locally
- WHEN the test executes
- THEN the terminal output SHALL read as a step-by-step walkthrough of OpenShell CLI operations
- AND each command and its result SHALL be clearly visible without `--verbose` flags or log level changes

### Requirement: Cleanup

The test SHALL clean up all resources it creates, even on failure. Cleanup is critical because CLI-created resources exist outside ACP's management scope and are not automatically garbage-collected.

#### Scenario: Normal cleanup

- GIVEN the test has created sandboxes, providers, and settings
- WHEN the test completes (pass or fail)
- THEN all test-created sandboxes SHALL be deleted via `openshell sandbox delete`
- AND all test-created providers SHALL be deleted via `openshell provider delete`
- AND all test-created settings SHALL be deleted via `openshell settings delete`
- AND cleanup failures SHALL be logged but SHALL NOT cause the test to fail (non-fatal)

#### Scenario: Cleanup on interrupt

- GIVEN the test is running and has created resources
- WHEN the test receives SIGINT or SIGTERM
- THEN the trap handler SHALL attempt to delete all tracked resources before exiting

#### Scenario: Skip cleanup for debugging

- GIVEN the test is invoked with `--skip-cleanup`
- WHEN the test completes
- THEN it SHALL retain all created resources
- AND it SHALL print the names of retained resources for manual inspection

---

## Implementation Notes

### File Locations

| Component | Path |
|---|---|
| Test script | `tests/e2e/openshell-cli-e2e.sh` |
| Policy fixture | `tests/e2e/fixtures/openshell-cli-test/test-policy.yaml` |
| Gateway CLI setup | mTLS cert extraction from `openshell-server-tls` secret + `openshell gateway add --local` |

### OpenShell CLI Command Reference

The test exercises the following `openshell` CLI command groups. Exact flag names should be verified against the installed CLI version, as some flags may differ from the examples below:

| Command | Purpose |
|---|---|
| `openshell gateway add --name <gw> --local <url> --cert <cert> --key <key> --insecure` | Register gateway via mTLS certs extracted from `openshell-server-tls` secret |
| `openshell gateway remove <name>` | Remove gateway registration |
| `openshell sandbox create --gateway <gw> --image <img> -- <cmd>` | Create a sandbox |
| `openshell sandbox list --gateway <gw>` | List sandboxes |
| `openshell sandbox get --gateway <gw> --name <n>` | Get sandbox details |
| `openshell sandbox exec --gateway <gw> --name <n> -- <cmd>` | Run command in sandbox |
| `openshell sandbox delete --gateway <gw> --name <n>` | Delete a sandbox |
| `openshell provider create --gateway <gw> --name <n> --type <t> ...` | Create a provider |
| `openshell provider get --gateway <gw> --name <n>` | Get provider details |
| `openshell provider list --gateway <gw>` | List providers |
| `openshell provider delete --gateway <gw> --name <n>` | Delete a provider |
| `openshell policy set --gateway <gw> --name <n> --file <f>` | Set sandbox policy |
| `openshell policy get --gateway <gw> --name <n>` | Get sandbox policy |
| `openshell policy list --gateway <gw>` | List policies |
| `openshell policy delete --gateway <gw> --name <n>` | Reset to default policy |
| `openshell settings set --gateway <gw> [--global\|--name <n>] --key <k> --value <v>` | Set a setting |
| `openshell settings get --gateway <gw> [--global\|--name <n>] --key <k>` | Get a setting |
| `openshell settings delete --gateway <gw> [--global\|--name <n>] --key <k>` | Delete a setting |

### Upstream E2E Test Reference

The OpenShell upstream repository (kathmandu workspace) contains Rust-based e2e tests that validate the same CLI commands against standalone gateways. The ACP test should exercise the same workflows to confirm ACP-managed gateways behave identically:

| Upstream Test | ACP Test Section |
|---|---|
| `e2e/rust/tests/smoke.rs` — sandbox create/exec/list/delete | Section 3: Sandbox operations |
| `e2e/rust/tests/provider_auto_create.rs` — provider lifecycle | Section 4: Provider operations |
| `e2e/rust/tests/live_policy_update.rs` — policy set/get/version/history | Section 5: Policy operations |
| `e2e/rust/tests/settings_management.rs` — settings get/set/delete | Section 6: Settings operations |

### Runner Image for Test Sandboxes

The test SHALL use a lightweight image for sandbox creation — not the full ACP runner image, since the test does not need the runner entrypoint. A standard Linux image (e.g., `alpine:latest` or the OpenShell default image) is sufficient for validating CLI operations. The runner image configured via `OPENSHELL_RUNNER_IMAGE` MAY be used if it is already loaded into the Kind cluster.

### Relationship to Existing E2E Tests

| Test | Focus | CLI Used |
|---|---|---|
| `gateway-e2e-test.sh` | ACP session lifecycle via API + `acpctl` | `acpctl` |
| `openshell-dual-tenant.sh` | Multi-tenant provisioning, observability | `curl` (API) |
| **`openshell-cli-e2e.sh`** (this spec) | OpenShell CLI commands against ACP gateways, with built-in demo-style verbose output | `openshell` |

The tests are complementary. `gateway-e2e-test.sh` validates the ACP platform plumbing. `openshell-cli-e2e.sh` validates that a power user can use the native OpenShell CLI directly against ACP-managed gateways without going through `acpctl`. Its integrated `run_cmd()` helper produces demo-quality output directly in CI logs, eliminating the need for a separate demo script.
