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

- New e2e test script at `tests/e2e/openshell-cli-e2e.sh`
- Demo script at `components/ambient-cli/demo-openshell.sh` following the `demo-*` pattern
- CLI-only testing: sandbox ops, provider ops, policy ops, settings ops
- Gateway connectivity setup via `acpctl gateway setup-cli` (validates the `acpctl` → `openshell` CLI handoff)
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
- Accept `--skip-cleanup` flag for post-mortem inspection
- Accept an optional `API_URL` positional argument (default: `http://localhost:<port-forward>`)
- Set up a port-forward to the API server
- Register the gateway with the `openshell` CLI via `acpctl gateway setup-cli` (validates the `acpctl`-to-`openshell` handoff path)
- Report per-section results with a final pass/fail summary
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

### Requirement: Gateway Connectivity via `acpctl gateway setup-cli`

The test SHALL authenticate to an ACP-managed OpenShell gateway using `acpctl gateway setup-cli`. This command reads the gateway's connection details and OIDC configuration from the ACP API, then delegates to the `openshell` CLI to register the gateway. Using `acpctl gateway setup-cli` (rather than manual mTLS cert extraction) validates the full "OpenShell as a Service" connectivity path that a power user would follow.

> **Implementation status:** The `acpctl gateway setup-cli` command exists at [`components/ambient-cli/cmd/acpctl/gateway/setup.go`](../../components/ambient-cli/cmd/acpctl/gateway/setup.go). Its verified signature is:
> ```
> acpctl gateway setup-cli [name] --gateway-url <url> [--project <namespace>] [--print]
> ```
> The `name` argument is optional (defaults to the project name). `--project` selects the namespace/project to look up the gateway in. `--print` outputs the `openshell gateway add` command instead of running it.

The gateway registration SHALL:
1. Call `acpctl gateway setup-cli --gateway-url <url> --project tenant-a` where `<url>` is the gateway's externally-reachable endpoint
2. For OIDC-enabled gateways: `acpctl gateway setup-cli` constructs and prints an `openshell gateway add` command with `--oidc-issuer`, `--oidc-client-id`, and `--oidc-audience` flags sourced from the Gateway resource's OIDC config. For local/Kind gateways, `--gateway-insecure` is added when the URL targets localhost
3. For non-OIDC (local) gateways: `acpctl gateway setup-cli` runs `openshell gateway add --name <name> --local <url>` directly
4. Verify connectivity via `openshell provider list --gateway <tenant>` or `openshell sandbox list --gateway <tenant>`

#### Scenario: Gateway registration succeeds via acpctl setup-cli

- GIVEN an ACP-managed OpenShell gateway is running in the `tenant-a` namespace
- AND the gateway is registered in the ACP API (via `acpctl apply -k`)
- WHEN the test runs `acpctl gateway setup-cli --gateway-url <url> --project tenant-a`
- THEN the command SHALL register the gateway with the `openshell` CLI
- AND `openshell sandbox list --gateway tenant-a` SHALL return without error (empty list or existing sandboxes)

#### Scenario: Gateway registration fails — gateway not found in API

- GIVEN no gateway named `tenant-a` exists in the ACP API
- WHEN the test runs `acpctl gateway setup-cli --gateway-url <url> --project tenant-a`
- THEN the command SHALL fail with an error indicating the gateway was not found
- AND the test SHALL skip gateway-dependent sections with a clear message

### Requirement: Sandbox Operations

The test SHALL exercise the full sandbox lifecycle using the `openshell` CLI against an ACP-managed gateway.

#### Scenario: Sandbox create

- GIVEN a registered gateway `tenant-a`
- WHEN the test runs `openshell sandbox create --gateway tenant-a --image <runner-image> -- sleep infinity`
- THEN the command SHALL succeed
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

### Requirement: Demo Script (`demo-openshell.sh`)

The test SHALL have a companion demo script at `components/ambient-cli/demo-openshell.sh` following the `demo-*` pattern established by `demo-kind.sh`, `demo-remote.sh`, and `demo-github.sh`. The demo script presents the same OpenShell CLI operations as the e2e test but in a human-readable, step-by-step, tmux-based format suitable for live demonstrations.

The demo script SHALL:
- Bootstrap a tmux session with a left pane (demo output) and right panes (sandbox watch/exec panels)
- Use colorized helpers (`bold()`, `dim()`, `cyan()`, `green()`, `yellow()`, `red()`, `sep()`, `step()`, `announce()`) matching the `demo-kind.sh` style
- Accept a `PAUSE` env var (default `0`) to control delay between steps for live presentation
- Walk through numbered sections: gateway setup, sandbox create, provider create, policy set + enforcement, settings set, cleanup
- Show `openshell` CLI commands as orange-highlighted `$ <command>` lines before executing them
- Attach a live `openshell sandbox exec` or SSH watch in a right-side tmux pane when a sandbox reaches READY
- Clean up all created resources on exit via trap
- Work against a Kind cluster provisioned by `make kind-up` (same prerequisites as the e2e test)

#### Scenario: Demo runs end-to-end

- GIVEN `make kind-up` has completed with `OPENSHELL_USE_GATEWAY=true`
- AND the `openshell` and `acpctl` CLIs are available
- WHEN `./components/ambient-cli/demo-openshell.sh` is executed
- THEN a tmux session SHALL open showing the step-by-step demo
- AND each step SHALL display the command being run and its output
- AND all resources SHALL be cleaned up at the end

#### Scenario: Demo with pause for live presentation

- GIVEN the demo is invoked with `PAUSE=3`
- WHEN each step completes
- THEN the script SHALL wait 3 seconds before proceeding to the next step

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
| Demo script | `components/ambient-cli/demo-openshell.sh` |
| Policy fixture | `tests/e2e/fixtures/openshell-cli-test/test-policy.yaml` |
| Gateway CLI setup | `acpctl gateway setup-cli` (from `components/ambient-cli/cmd/acpctl/gateway/setup.go`) |

### OpenShell CLI Command Reference

The test exercises the following `openshell` CLI command groups. Exact flag names should be verified against the installed CLI version, as some flags may differ from the examples below:

| Command | Purpose |
|---|---|
| `acpctl gateway setup-cli [name] --gateway-url <url> [--project <ns>] [--print]` | Register gateway (delegates to `openshell gateway add`) |
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
| **`openshell-cli-e2e.sh`** (this spec) | OpenShell CLI commands against ACP gateways | `openshell` |

| **`demo-openshell.sh`** (this spec) | Interactive tmux demo of the same CLI flows | `openshell` |

The tests are complementary. `gateway-e2e-test.sh` validates the ACP platform plumbing. `openshell-cli-e2e.sh` validates that a power user can use the native OpenShell CLI directly against ACP-managed gateways without going through `acpctl`. `demo-openshell.sh` presents the same CLI operations in a step-by-step tmux format for live demonstrations.
