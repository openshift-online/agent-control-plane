# Integration Deployment Specification

> Date: 2026-07-31
> Status: Design
> Related: [control-plane.spec.md](control-plane.spec.md), [cross-cutting.spec.md](../standards/platform/cross-cutting.spec.md)
> Issue: [ENGPROD-10253](https://redhat.atlassian.net/browse/ENGPROD-10253)

## Purpose

Define the desired state for automated continuous deployment of the Agent Control Plane to a dedicated integration environment. When all CI checks pass on `main`, the system deploys the latest Konflux-built images to the hcmai-01 ROSA cluster via ArgoCD, then runs a full verification suite. This integration environment serves as the quality gate before promotion to stage (hcmai-02) and production (hcmai-03).

The ROSA cluster is internal (VPN-only), so deployment is pull-based: ArgoCD on the cluster watches a GitOps repository on internal GitLab for manifest and image reference changes.

## Cluster Topology

| Environment | Cluster | Purpose |
|-------------|---------|---------|
| Integration | hcmai-01 | Automated deploy of `main`, full test suite |
| Stage | hcmai-02 | Promotion target when integration is green |
| Production | hcmai-03 | Production |

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Konflux images, not GHA images | Red Hat internal standard; provides SLSA attestation, vulnerability scanning (Clair, Snyk, ClamAV), RPM signature verification, and supply chain compliance via Tekton Chains. Other Red Hat projects already use Konflux images for internal deployments. |
| Pull-based deployment via ArgoCD | The ROSA cluster is internal/VPN — GitHub Actions cannot push to it. ArgoCD on the cluster pulls from internal GitLab, which the cluster can reach. |
| GitOps repo on internal GitLab | `gitlab.cee.redhat.com/agent-control-plane/agent-gitops` is reachable from ROSA clusters. Separating deployment configuration from application source follows GitOps best practice. |
| Update-in-place, not ephemeral | Integration is a persistent environment continuously updated, unlike the ephemeral per-PR namespaces used by pr-test on Stage. Initial bootstrap is manual and out of scope. |
| Unified golden test suite | A single parameterized test suite SHALL be used across all environments (kind, integration, stage, production). Follow-up work will consolidate the existing suites (`components/pr-test/e2e-smoke.sh`, `tests/e2e/hcmai-smoke.sh`, `scripts/tests/*`) into one. |
| Secrets managed by Vault | Secrets are provisioned into the cluster via HashiCorp Vault and the secrets operator. They are not stored in the GitOps repo and are not managed from this codebase. |
| Image digests, not mutable tags | Digest pinning (`@sha256:...`) ensures ArgoCD detects changes and guarantees the exact image that was scanned and attested is what gets deployed. |

## Requirements

### Requirement: Image Source

The integration overlay SHALL reference Konflux-built images from `quay.io/redhat-user-workloads/hcm-eng-prod-tenant/agent-control-plane-main/` pinned by digest.

The following components SHALL be deployed:

| Component | Konflux Image |
|-----------|--------------|
| API Server | `quay.io/redhat-user-workloads/hcm-eng-prod-tenant/agent-control-plane-main/acp-api-server-main` |
| Control Plane | `.../control-plane-main` |
| UI | `.../acp-ui-main` |
| Runner | `.../acp-runner-main` |
| Runner (OpenShell) | `.../acp-runner-openshell-main` |

Credential sidecars are deprecated — the platform uses the provider model exclusively. Credential sidecar images SHALL NOT be built or deployed.

The MCP server image MAY be excluded if the openshell provider flow does not require it.

The control plane environment patches SHALL reference Konflux image paths for the runner image (the `RUNNER_IMAGE` env var used when spawning session pods).

#### Scenario: Konflux image used for deployment

- GIVEN a merge to `main` triggers Konflux builds
- WHEN all component builds complete successfully
- THEN the integration overlay in `agent-gitops` references the new Konflux image digests
- AND the deployed pods on hcmai-01 run images from `quay.io/redhat-user-workloads/hcm-eng-prod-tenant/agent-control-plane-main/`

#### Scenario: Image digest pinning

- GIVEN a Konflux build produces image `acp-api-server-main@sha256:abc123...`
- WHEN the image reference is committed to `agent-gitops`
- THEN the reference uses the full digest form, not a mutable tag
- AND ArgoCD detects the digest change and triggers a sync

### Requirement: Image Update Flow

After all Konflux builds for a `main` commit succeed, the system SHALL update image references in the `agent-gitops` repository on internal GitLab (`gitlab.cee.redhat.com/agent-control-plane/agent-gitops`).

The update mechanism SHALL NOT commit to `agent-gitops` until all component images for the same commit have built successfully — partial updates (some components at commit A, others at commit B) SHALL NOT occur.

The update SHOULD be atomic: a single commit updating all component image digests.

#### Scenario: Successful build triggers image update

- GIVEN all Konflux push pipelines complete for commit `abc1234` on `main`
- WHEN the image-update mechanism runs
- THEN a single commit is pushed to `agent-gitops` updating all component image digests
- AND the commit message references the source commit SHA (`abc1234`)

#### Scenario: Partial build failure blocks update

- GIVEN all but one Konflux push pipeline completes for commit `abc1234`
- WHEN the `acp-runner-main` build fails
- THEN no commit is pushed to `agent-gitops`
- AND the integration environment continues running the previous known-good images

#### Scenario: Rapid successive merges

- GIVEN commit `abc1234` builds are in progress
- WHEN commit `def5678` is merged to `main` and its builds complete first
- THEN the image-update mechanism SHALL update `agent-gitops` with `def5678` images
- AND the `abc1234` update is skipped (latest-wins)

### Requirement: ArgoCD Continuous Sync

ArgoCD on hcmai-01 SHALL be configured to watch the `agent-gitops` repository and automatically sync the integration overlay.

The ArgoCD Application SHALL have:
- Automated sync policy with prune enabled
- Self-healing enabled (drift from desired state is auto-corrected)
- Retry policy for transient sync failures

ArgoCD SHALL NOT auto-sync if the previous sync's PostSync hooks (verification) failed.

#### Scenario: Image update triggers rollout

- GIVEN ArgoCD watches `agent-gitops` with auto-sync enabled
- WHEN a new commit updates image digests in the integration overlay
- THEN ArgoCD detects the change and begins a sync
- AND the sync applies the updated manifests to the hcmai-01 cluster
- AND pods roll out with the new images

#### Scenario: Cluster drift is auto-corrected

- GIVEN a deployment on hcmai-01 is manually scaled or modified
- WHEN ArgoCD's self-healing detects the drift
- THEN ArgoCD restores the resource to match the desired state in `agent-gitops`

### Requirement: Integration Overlay

The integration Kustomize overlay SHALL live in the `agent-gitops` repository and follow the structural pattern established by `components/manifests/overlays/hcmais/` in the application repo.

The integration overlay SHALL mirror the full production resource set to ensure promotion fidelity — resources that are deleted in the existing `hcmais/` overlay (MinIO, LimitRange, NetworkPolicy) SHALL be retained.

The overlay SHALL include:
- A dedicated namespace for integration workloads
- Kustomize components for `postgresql-rhel` and `ambient-api-server-db`
- Environment patches for `ambient-api-server`, `ambient-control-plane`, and `ambient-ui` deployments
- OpenShift Routes for API server and UI with TLS edge termination
- Image references using Konflux registry paths with digest pinning

The control plane environment patch SHALL configure:
- Internal service URLs referencing the integration namespace
- OIDC token URL pointing to the integration Keycloak instance
- Vertex AI configuration (project ID, region, credentials path)
- Konflux image paths for the runner image (`RUNNER_IMAGE` env var)

#### Scenario: Overlay builds successfully

- GIVEN the integration overlay in `agent-gitops`
- WHEN `kustomize build` is run against it
- THEN it produces valid Kubernetes manifests
- AND all image references point to Konflux registry paths

#### Scenario: Integration overlay retains all base resources

- GIVEN the integration overlay is intended for promotion to stage and production
- WHEN compared to the existing `hcmais/` overlay
- THEN the integration overlay does NOT include delete-patches for MinIO, PostgreSQL, LimitRange, or NetworkPolicy
- AND environment-specific values (namespace, hostnames, OIDC URLs, image references) are the only differences from base

### Requirement: Post-Deploy Verification

After ArgoCD completes a sync, a verification Job SHALL run as an ArgoCD PostSync hook inside the cluster.

The verification SHALL execute the unified golden test suite. This suite consolidates the existing test scripts (`components/pr-test/e2e-smoke.sh`, `tests/e2e/hcmai-smoke.sh`, `scripts/tests/*`) into a single parameterized test runner usable across all environments (kind, integration, stage, production). Until unification is complete, the PostSync hook SHALL use the best available existing suite.

The golden test suite SHALL cover at minimum:
1. Authenticate via OIDC client_credentials
2. Create a test project
3. Configure a Vertex AI provider and credential
4. Create an agent
5. Create a session and wait for Running phase
6. Send a prompt and validate LLM response
7. Verify response correctness

The verification Job SHALL use the `argocd.argoproj.io/hook: PostSync` annotation with `argocd.argoproj.io/sync-wave: "1"` to run after the `bootstrap-admin` Job (wave 0).

The verification Job SHALL report results via its exit code: 0 for success, non-zero for failure. ArgoCD treats PostSync hook failure as a degraded sync.

Additional test suites (RBAC, gateway, scheduled sessions) SHOULD be included as separate PostSync Jobs or as stages within the verification Job.

#### Scenario: Deployment passes verification

- GIVEN ArgoCD completes a sync deploying new images
- WHEN the PostSync verification Job runs
- THEN it authenticates, creates test resources, triggers an LLM session, and validates the response
- AND the Job exits with code 0
- AND ArgoCD reports the sync as healthy

#### Scenario: Deployment fails verification

- GIVEN ArgoCD completes a sync deploying new images
- WHEN the PostSync verification Job fails (LLM response not received, session stuck, auth failure)
- THEN the Job exits with a non-zero code
- AND ArgoCD reports the sync as degraded
- AND the failure is visible in the ArgoCD dashboard

#### Scenario: Verification runs after bootstrap

- GIVEN `bootstrap-admin` Job has `argocd.argoproj.io/hook: PostSync` at sync-wave 0
- WHEN ArgoCD runs PostSync hooks
- THEN `bootstrap-admin` completes before the verification Job starts
- AND the verification Job can authenticate against a seeded admin user

### Requirement: Secret Management

Secrets SHALL be managed by HashiCorp Vault and provisioned into the hcmai-01 cluster via the Vault secrets operator. Secrets SHALL NOT be stored in the `agent-gitops` repository or managed from this codebase.

Required secrets:

| Secret | Purpose |
|--------|---------|
| `credential-encryption-key` | AES-256-GCM keyring for credential encryption at rest |
| `ambient-control-plane-oidc` | OIDC client_id and client_secret for control plane auth |
| `ambient-anthropic` | Anthropic API key (optional, for direct API fallback) |
| `ambient-vertex` | GCP service account JSON for Vertex AI inference |
| `sso-credentials` | SSO issuer URL, client ID/secret, session secret for UI auth |
| `ambient-api-server-db` | PostgreSQL connection details (host, port, user, password, db name) |
| `postgresql-credentials` | PostgreSQL superuser credentials for the RHEL PostgreSQL instance |

Keycloak SHALL be deployed separately, following the existing `overlays/hcmais/keycloak/` sub-overlay pattern with its own namespace.

#### Scenario: Secret missing blocks deployment

- GIVEN the integration overlay references `ambient-control-plane-oidc` secret
- WHEN the secret does not exist in the namespace
- THEN the control plane pod fails to start (env var injection fails)
- AND ArgoCD reports the application as degraded

#### Scenario: Secret rotation does not require GitOps commit

- GIVEN `ambient-vertex` secret needs rotation (new GCP service account key)
- WHEN the secret is rotated in Vault and the secrets operator syncs the update to the cluster
- THEN the control plane pod restarts and picks up the new credentials
- AND no commit to `agent-gitops` is required

### Requirement: Deployment Gating

The image-update mechanism SHALL only trigger when all CI checks on `main` are green.

At minimum, "green" means all Konflux push pipelines completed successfully for the target commit. The mechanism SHOULD also gate on GitHub Actions CI status (unit tests, linting, kustomize validation) if that status is available.

ArgoCD guarantees that PostSync hooks (verification tests) only run after the sync is complete and all resources are healthy. This means the deployment pipeline does not need a separate mechanism to confirm ArgoCD has finished syncing — the PostSync hook annotation provides this guarantee natively.

#### Scenario: Green CI triggers deployment

- GIVEN commit `abc1234` is merged to `main`
- WHEN all Konflux pipelines and GHA CI checks pass
- THEN the image-update mechanism commits new digests to `agent-gitops`
- AND ArgoCD syncs the new images to hcmai-01
- AND PostSync hooks run only after all resources reach a healthy state

#### Scenario: Failing CI blocks deployment

- GIVEN commit `abc1234` is merged to `main`
- WHEN the `acp-ui-main` Konflux pipeline fails (e.g. Clair vulnerability scan)
- THEN no image update is committed to `agent-gitops`
- AND the integration environment remains on the previous version

### Requirement: Rollback

When PostSync verification fails, the system SHALL NOT automatically promote the failing version further (no auto-promotion to stage).

The system SHOULD support rollback to the previous known-good version by reverting the image-update commit in `agent-gitops`. ArgoCD auto-sync then applies the reverted (previous) image digests.

#### Scenario: Manual rollback via git revert

- GIVEN a deployment to hcmai-01 fails PostSync verification
- WHEN an operator runs `git revert HEAD` on `agent-gitops` and pushes
- THEN ArgoCD detects the revert commit
- AND syncs the cluster back to the previous known-good image digests
- AND the PostSync verification runs again against the rolled-back version

#### Scenario: Failed deployment does not auto-promote

- GIVEN the integration environment (hcmai-01) has a degraded sync
- WHEN the stage promotion mechanism checks integration health
- THEN it finds the degraded status
- AND does not promote to stage (hcmai-02)

## Future Work

The following are anticipated extensions but are not in scope for this spec:

- **Stage promotion**: Automated promotion from integration (hcmai-01) to stage (hcmai-02) when verification passes, using the same ArgoCD + GitOps pattern with a separate overlay.
- **PR test migration**: Moving PR test workloads from the Stage cluster to integration (hcmai-01). Currently PR tests use `components/pr-test/install-openshift.sh` for ephemeral deploys on Stage; the future state would use integration as the PR test target.
- **Unified test suite** (actively planned): Consolidating `components/pr-test/e2e-smoke.sh`, `tests/e2e/hcmai-smoke.sh`, and `scripts/tests/*` into a single parameterized golden test suite usable across all environments (kind, integration, stage, production). This is a prerequisite for full deployment automation.
- **Notification**: Alerting (Slack, email, or PagerDuty) on deployment failures or verification regressions.

## References

- [HCMAIS overlay]: ../../components/manifests/overlays/hcmais/kustomization.yaml
- [HCMAIS control plane patch]: ../../components/manifests/overlays/hcmais/control-plane-env-patch.yaml
- [hcmai-smoke.sh]: ../../tests/e2e/hcmai-smoke.sh
- [pr-test e2e-smoke.sh]: ../../components/pr-test/e2e-smoke.sh
- [install-openshift.sh]: ../../components/pr-test/install-openshift.sh
- [bootstrap-admin-job.yaml]: ../../components/manifests/base/bootstrap-admin-job.yaml
- [Tekton pipelines]: ../../.tekton/
