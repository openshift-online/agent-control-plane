# Integration Deployment Specification

> Date: 2026-07-31
> Status: Design
> Related: [control-plane.spec.md](control-plane.spec.md), [cross-cutting.spec.md](../standards/platform/cross-cutting.spec.md)
> Issue: [ENGPROD-10253](https://redhat.atlassian.net/browse/ENGPROD-10253)

## Purpose

Define the desired state for automated continuous deployment of the Agent Control Plane to a dedicated integration environment. When Konflux builds new images from `main`, ArgoCD Image Updater on hcmai-01 detects the new digests in Quay and rolls them out automatically. A PostSync verification suite then tests the live deployment — if tests fail, the system rolls back. This is an integration/"nightly" environment; stability is validated, not assumed.

The ROSA cluster is internal (VPN-only), so deployment is pull-based: ArgoCD Image Updater on the cluster polls Quay for new image digests. No git commits, PRs, or external CI systems are involved in the image update path.

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
| ArgoCD Image Updater for image rollout | Konflux already pushes images to Quay on every merge to `main`. ArgoCD Image Updater watches Quay and rolls out new digests automatically — no git commits, Release pipelines, or GitOps PRs needed for image changes. |
| Deploy first, test second, rollback on failure | This is an integration environment, not production. Testing against a live deployment gives real confidence. If tests fail, the system rolls back to the previous known-good digests. No pre-deploy gating beyond a successful Konflux build. |
| `agent-gitops` for manifests only | `agent-gitops` defines ACP resource types and Kustomize overlays. Image versions are managed entirely by ArgoCD Image Updater — `agent-gitops` is only changed when the shape of resources changes, via manual developer commits. |
| Pull-based deployment via ArgoCD | The ROSA cluster is internal/VPN — GitHub Actions cannot reach it. ArgoCD on the cluster pulls manifests from internal GitLab and images from Quay, both of which the cluster can reach. |
| Update-in-place, not ephemeral | Integration is a persistent environment continuously updated, unlike the ephemeral per-PR namespaces used by pr-test on Stage. Initial bootstrap is manual and out of scope. |
| Unified golden test suite | A single parameterized test suite SHALL be used across all environments (kind, integration, stage, production). Follow-up work will consolidate the existing suites (`components/pr-test/e2e-smoke.sh`, `tests/e2e/hcmai-smoke.sh`, `scripts/tests/*`) into one. |
| Secrets managed by Vault | Secrets are provisioned into the cluster via HashiCorp Vault and the secrets operator. They are not stored in the GitOps repo and are not managed from this codebase. |

## Requirements

### Requirement: Image Source

Konflux builds component images to `quay.io/redhat-user-workloads/hcm-eng-prod-tenant/agent-control-plane-main/` on every merge to `main`. These images are already available in Quay today.

The following components SHALL be deployed:

| Component | Konflux Image |
|-----------|--------------|
| API Server | `quay.io/redhat-user-workloads/hcm-eng-prod-tenant/agent-control-plane-main/acp-api-server-main` |
| Control Plane | `.../control-plane-main` |
| UI | `.../acp-ui-main` |
| Runner | `.../acp-runner-main` |
| Runner (OpenShell) | `.../acp-runner-openshell-main` |


The control plane environment patches SHALL reference Konflux image paths for the runner image (the `RUNNER_IMAGE` env var used when spawning session pods).

#### Scenario: Konflux images are available in Quay

- GIVEN a merge to `main` triggers Konflux builds
- WHEN all component builds complete successfully
- THEN images are pushed to `quay.io/redhat-user-workloads/hcm-eng-prod-tenant/agent-control-plane-main/` with digest tags
- AND they are available for ArgoCD Image Updater to detect

### Requirement: Image Update Flow

ArgoCD Image Updater SHALL be deployed on hcmai-01 and configured to watch the Konflux Quay repository for new image digests. When new digests are detected, Image Updater updates the ArgoCD Application's image overrides, triggering a sync and pod rollout.

No git commits, Release pipelines, or PRs are involved in the image update path. Image versions are managed entirely by ArgoCD Image Updater; `agent-gitops` is not modified.

The ArgoCD Application SHALL be annotated to configure Image Updater:

```yaml
metadata:
  annotations:
    argocd-image-updater.argoproj.io/image-list: >
      api=quay.io/redhat-user-workloads/hcm-eng-prod-tenant/agent-control-plane-main/acp-api-server-main,
      cp=quay.io/redhat-user-workloads/hcm-eng-prod-tenant/agent-control-plane-main/control-plane-main,
      ui=quay.io/redhat-user-workloads/hcm-eng-prod-tenant/agent-control-plane-main/acp-ui-main,
      runner=quay.io/redhat-user-workloads/hcm-eng-prod-tenant/agent-control-plane-main/acp-runner-main,
      openshell=quay.io/redhat-user-workloads/hcm-eng-prod-tenant/agent-control-plane-main/acp-runner-openshell-main
    argocd-image-updater.argoproj.io/api.update-strategy: digest
    argocd-image-updater.argoproj.io/cp.update-strategy: digest
    argocd-image-updater.argoproj.io/ui.update-strategy: digest
    argocd-image-updater.argoproj.io/runner.update-strategy: digest
    argocd-image-updater.argoproj.io/openshell.update-strategy: digest
```

Image Updater SHALL use the `digest` update strategy to track the latest image pushed to each repository.

#### Scenario: New Konflux build triggers rollout

- GIVEN ArgoCD Image Updater is configured to watch the Konflux Quay repositories
- WHEN Konflux pushes new image digests after a successful build of commit `abc1234`
- THEN Image Updater detects the new digests on its next poll cycle
- AND updates the ArgoCD Application's image overrides
- AND ArgoCD syncs the new images to hcmai-01
- AND pods roll out with the new images

#### Scenario: Partial build does not block other components

- GIVEN the `acp-runner-main` build fails for commit `abc1234`
- WHEN the other four component builds succeed and push to Quay
- THEN Image Updater rolls out the four updated components
- AND the runner continues running the previous image
- AND PostSync verification determines whether the mixed state is healthy

#### Scenario: Rapid successive merges

- GIVEN commit `abc1234` builds are in progress
- WHEN commit `def5678` is merged to `main` and its builds push to Quay
- THEN Image Updater picks up whichever digests are newest at its next poll
- AND the cluster converges to the latest available images

### Requirement: ArgoCD Application Configuration

ArgoCD on hcmai-01 SHALL manage ACP deployment via an Application resource that watches `agent-gitops` for manifest changes and accepts image overrides from Image Updater.

The following is the reference ArgoCD Application configuration:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: acp-integration
  namespace: openshift-gitops
  annotations:
    # Image Updater: watch Konflux Quay repos for new digests
    argocd-image-updater.argoproj.io/image-list: >
      api=quay.io/redhat-user-workloads/hcm-eng-prod-tenant/agent-control-plane-main/acp-api-server-main,
      cp=quay.io/redhat-user-workloads/hcm-eng-prod-tenant/agent-control-plane-main/control-plane-main,
      ui=quay.io/redhat-user-workloads/hcm-eng-prod-tenant/agent-control-plane-main/acp-ui-main,
      runner=quay.io/redhat-user-workloads/hcm-eng-prod-tenant/agent-control-plane-main/acp-runner-main,
      openshell=quay.io/redhat-user-workloads/hcm-eng-prod-tenant/agent-control-plane-main/acp-runner-openshell-main
    argocd-image-updater.argoproj.io/api.update-strategy: digest
    argocd-image-updater.argoproj.io/cp.update-strategy: digest
    argocd-image-updater.argoproj.io/ui.update-strategy: digest
    argocd-image-updater.argoproj.io/runner.update-strategy: digest
    argocd-image-updater.argoproj.io/openshell.update-strategy: digest
    # Write-back: store overrides in a .argocd-source file in the GitOps repo
    argocd-image-updater.argoproj.io/write-back-method: git
    argocd-image-updater.argoproj.io/write-back-target: kustomization
    argocd-image-updater.argoproj.io/git-branch: main
spec:
  project: default
  source:
    repoURL: https://gitlab.cee.redhat.com/agent-control-plane/agent-gitops.git
    targetRevision: main
    path: overlays/integration
  destination:
    server: https://kubernetes.default.svc
    namespace: acp-integration
  syncPolicy:
    automated:
      prune: true        # Remove resources deleted from GitOps
      selfHeal: true      # Auto-correct manual drift
    retry:
      limit: 3
      backoff:
        duration: 30s
        factor: 2
        maxDuration: 3m
    syncOptions:
      - CreateNamespace=true
      - PrunePropagationPolicy=foreground
```

The `write-back-method: git` configuration causes Image Updater to commit a `.argocd-source-acp-integration.yaml` file to the GitOps repo with the resolved image digests. This provides an audit trail of image versions without mixing image lifecycle into the manifest definitions.

#### Scenario: Image Updater triggers rollout

- GIVEN ArgoCD Image Updater detects new digests in Quay
- WHEN it updates the Application's image overrides
- THEN ArgoCD begins a sync applying the new images
- AND pods roll out with the updated digests
- AND PostSync hooks run after all resources are healthy

#### Scenario: Manifest change triggers rollout

- GIVEN a developer commits a manifest change to `agent-gitops` (e.g. new env var, Route update)
- WHEN ArgoCD detects the new commit
- THEN ArgoCD syncs the manifest changes to hcmai-01
- AND PostSync hooks run after all resources are healthy

#### Scenario: Cluster drift is auto-corrected

- GIVEN a deployment on hcmai-01 is manually scaled or modified
- WHEN ArgoCD's self-healing detects the drift
- THEN ArgoCD restores the resource to match the desired state

### Requirement: Integration Overlay

The integration Kustomize overlay SHALL live in the `agent-gitops` repository and follow the structural pattern established by `components/manifests/overlays/hcmais/` in the application repo.

The integration overlay SHALL mirror the full production resource set to ensure promotion fidelity — resources that are deleted in the existing `hcmais/` overlay (MinIO, LimitRange, NetworkPolicy) SHALL be retained.

The overlay SHALL include:
- A dedicated namespace for integration workloads
- Kustomize components for `postgresql-rhel` and `ambient-api-server-db`
- Environment patches for `ambient-api-server`, `ambient-control-plane`, and `ambient-ui` deployments
- OpenShift Routes for API server and UI with TLS edge termination

The overlay SHALL NOT include image references with specific digests or tags — image versions are managed entirely by ArgoCD Image Updater, not by the overlay.

The control plane environment patch SHALL configure:
- Internal service URLs referencing the integration namespace
- OIDC token URL pointing to the integration Keycloak instance
- Vertex AI configuration (project ID, region, credentials path)
- Konflux image paths for the runner image (`RUNNER_IMAGE` env var)

#### Scenario: Overlay builds successfully

- GIVEN the integration overlay in `agent-gitops`
- WHEN `kustomize build` is run against it
- THEN it produces valid Kubernetes manifests
- AND image references use Konflux registry paths (digests are applied at runtime by Image Updater)

#### Scenario: Integration overlay retains all base resources

- GIVEN the integration overlay is intended for promotion to stage and production
- WHEN compared to the existing `hcmais/` overlay
- THEN the integration overlay does NOT include delete-patches for MinIO, PostgreSQL, LimitRange, or NetworkPolicy
- AND environment-specific values (namespace, hostnames, OIDC URLs) are the only differences from base

### Requirement: ACP Types Management

ACP resource types (Projects, Agents, Credentials, Providers, Policies, RoleBindings, Gateways, Clusters) SHALL be defined as YAML manifests in the `agent-gitops` repository and applied to the integration environment via `acpctl apply`.

The `agent-gitops` repository already organizes ACP types using Kustomize base/overlay structure:

```
teams/
  base/                          # Shared ACP type definitions
    kustomization.yaml           # Project, Agents, Providers, Credentials, RoleBindings
    project.yaml
    lead.yaml, engineer.yaml, amber.yaml
    provider-vertex.yaml, provider-github.yaml, ...
    credential-vertex.yaml, credential-github.yaml, ...
    rolebindings.yaml
  overlays/
    hcmai-01/                    # Integration cluster overlay
      kustomization.yaml         # References ../../base, adds cluster-specific resources
      project-patch.yaml         # Project name/labels for hcmai-01
      credential-kubeconfig.yaml # Cluster-specific kubeconfig credential
      agents-patch.yaml          # Agent patches for this environment
      rolebindings.yaml          # Cluster-specific role bindings
    hcmai-02/                    # Stage cluster overlay
    hcmai-03/                    # Production cluster overlay
```

The PostSync verification Job SHALL apply the integration overlay:

```shell
acpctl apply -k teams/overlays/hcmai-01/
```

`acpctl apply` talks to the ACP API server (not Kubernetes directly) and supports create-or-update semantics for all ACP resource types. The Kustomize overlay pattern enables environment-specific overrides (different project names, credentials, and patches per cluster) while sharing base type definitions.

ACP types SHALL be applied as the first step of the PostSync verification Job (see Post-Deploy Verification below). The verification Job already runs after the Kubernetes manifests are synced and the API server is healthy, so `acpctl apply -k` runs first to ensure ACP types are current, then the test suite validates the full deployment including those types.

#### Scenario: ACP types applied after deployment

- GIVEN the integration environment's ACP API server is healthy after an ArgoCD sync
- WHEN the PostSync verification Job runs `acpctl apply -k teams/overlays/hcmai-01/` as its first step
- THEN Projects, Agents, Providers, Credentials, and other ACP types are created or updated
- AND the test suite runs immediately after against the updated types

#### Scenario: ACP type change does not require image update

- GIVEN a developer adds a new Agent definition to `agent-gitops/teams/overlays/hcmai-01/`
- WHEN ArgoCD detects the commit and syncs
- THEN the PostSync Job applies the new Agent via `acpctl apply -k`
- AND the test suite validates the new type
- AND no image rollout occurs — only the ACP type is updated

### Requirement: Post-Deploy Verification

After ArgoCD completes a sync, a verification Job SHALL run as an ArgoCD PostSync hook inside the cluster. The Job performs two steps in sequence:

1. **Apply ACP types**: Run `acpctl apply -k teams/overlays/hcmai-01/` to ensure all ACP resource types (Projects, Agents, Providers, etc.) are current
2. **Run test suite**: Execute the unified golden test suite against the live deployment

The verification container image SHALL include both `acpctl` and the test suite scripts.

The test suite consolidates the existing test scripts (`components/pr-test/e2e-smoke.sh`, `tests/e2e/hcmai-smoke.sh`, `scripts/tests/*`) into a single parameterized test runner usable across all environments (kind, integration, stage, production). Until unification is complete, the PostSync hook SHALL use the best available existing suite.

The golden test suite SHALL cover at minimum:
1. Authenticate via OIDC client_credentials
2. Create a test project
3. Configure a Vertex AI provider and credential
4. Create an agent
5. Create a session and wait for Running phase
6. Send a prompt and validate LLM response
7. Verify response correctness

The verification Job SHALL use the `argocd.argoproj.io/hook: PostSync` annotation with `argocd.argoproj.io/sync-wave: "1"` to run after the `bootstrap-admin` Job (wave 0).

The verification Job SHALL report results via its exit code: 0 for success, non-zero for failure. If `acpctl apply -k` fails, the Job exits non-zero without running the test suite. ArgoCD treats PostSync hook failure as a degraded sync.

Additional test suites (RBAC, gateway, scheduled sessions) SHOULD be included as additional stages within the verification Job.

#### Scenario: Deployment passes verification

- GIVEN ArgoCD completes a sync deploying new images
- WHEN the PostSync verification Job runs
- THEN `acpctl apply -k teams/overlays/hcmai-01/` applies ACP types successfully
- AND the test suite authenticates, creates test resources, triggers an LLM session, and validates the response
- AND the Job exits with code 0
- AND ArgoCD reports the sync as healthy

#### Scenario: Deployment fails verification

- GIVEN ArgoCD completes a sync deploying new images
- WHEN the PostSync verification Job's test suite fails (LLM response not received, session stuck, auth failure)
- THEN the Job exits with a non-zero code
- AND ArgoCD reports the sync as degraded
- AND the failure is visible in the ArgoCD dashboard

#### Scenario: ACP type apply fails

- GIVEN ArgoCD completes a sync deploying new images
- WHEN the PostSync verification Job runs `acpctl apply -k` and it fails (API server unreachable, invalid manifest)
- THEN the Job exits with a non-zero code without running the test suite
- AND ArgoCD reports the sync as degraded

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

### Requirement: Rollback

When PostSync verification fails, the system SHALL NOT automatically promote the failing version further (no auto-promotion to stage).

ArgoCD Image Updater tracks the previous known-good image digests. Rollback SHALL be supported by pinning the ArgoCD Application's image overrides to the previous digests, either via the ArgoCD CLI or by temporarily disabling Image Updater for the Application and manually setting image overrides.

#### Scenario: Rollback after failed verification

- GIVEN a deployment to hcmai-01 fails PostSync verification
- WHEN an operator pins the ArgoCD Application to the previous known-good image digests
- THEN ArgoCD syncs the cluster back to the previous images
- AND the PostSync verification runs again against the rolled-back version

#### Scenario: Failed deployment does not auto-promote

- GIVEN the integration environment (hcmai-01) has a degraded sync
- WHEN the stage promotion mechanism checks integration health
- THEN it finds the degraded status
- AND does not promote to stage (hcmai-02)

## Future Work

The following are anticipated extensions but are not in scope for this spec:

- **Stage promotion**: Automated promotion from integration (hcmai-01) to stage (hcmai-02) when verification passes. Stage and production deployments MAY use a gated Konflux Release pipeline with Enterprise Contract validation, unlike the ungated integration flow.
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
- [ArgoCD Image Updater]: https://argocd-image-updater.readthedocs.io/
