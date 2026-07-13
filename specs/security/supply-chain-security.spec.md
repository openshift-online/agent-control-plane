# Supply Chain Security

> This specification was created in response to findings from the 2026-07 ProdSec
> security audit. Each requirement references the originating finding ID (fNNN)
> for traceability.

The platform SHALL implement supply chain security controls covering CI/CD
pipeline integrity, container image provenance, dependency pinning, and build
reproducibility. The platform currently operates at SLSA Build L0 with no
image signing, provenance attestation, or SBOM generation.

## Requirements

### Requirement: CI Secrets Must Not Be Exposed to PR-Controlled Code (f026)

The `AUTO_MERGE_PAT` and production registry credentials SHALL NOT be available
in `pull_request`-triggered workflow jobs that execute PR-controlled code. The
merge-gate workflows (`lint.yml`, `unit-tests.yml`, `components-build-deploy.yml`,
`sdd-preflight.yml`) currently check out the PR merge ref and run
`try-enqueue.sh` with the PAT — any same-repo branch PR can replace the script
and exfiltrate the token.

The enqueue step SHALL run from the base ref (`ref: default branch`) or a
`workflow_run` job that never executes PR-controlled code. The long-lived PAT
SHALL be replaced with a per-run fine-grained GitHub App token scoped to
`pull_requests:write`.

#### Scenario: PR-controlled script cannot access merge PAT

- GIVEN a pull_request workflow runs
- WHEN the merge-gate job executes
- THEN it checks out the base branch (not the PR merge ref) for the enqueue script
- AND the `AUTO_MERGE_PAT` is not available to PR-controlled code

### Requirement: PR Registry Credentials Scoped to PR Tags (f039)

Production registry credentials (`QUAY_USERNAME`/`QUAY_PASSWORD`) SHALL NOT be
used in `pull_request`-triggered builds. PR builds SHALL use a robot account
restricted to `pr-*` tag patterns (or a scratch namespace). Production push
credentials SHALL be available only in push/release workflows or
reviewer-gated GitHub Environments.

The `docs-preview.yml` workflow SHALL be split into an unprivileged build job
and a privileged deploy job that never runs PR code.

#### Scenario: PR build uses scoped credentials

- GIVEN a pull_request triggers a build workflow
- WHEN the build pushes to the registry
- THEN it authenticates with a robot account restricted to `pr-*` tags
- AND the robot account cannot push to `:latest` or release tags

### Requirement: Human Review Required for Merges to Main (f040)

Automated PR approval and merge without human review SHALL be eliminated for
code that ships in production images:

1. The bot-self-approval pattern (GitHub App approves its own PR) SHALL be
   restricted to CODEOWNERS-carved-out paths (e.g., generated files)
2. The `auto-merge.yml` workflow SHALL require human approval for PRs that
   modify production code
3. Renovate automerge SHALL be disabled for packages shipped in production
   images

#### Scenario: Bot-generated PR requires human review

- GIVEN a workflow creates a PR modifying production code
- WHEN the workflow approves the PR with a GitHub App token
- THEN the PR still requires at least one human review
- AND auto-merge does not proceed without human approval

### Requirement: Image Signing, Provenance, and SBOM (f041)

All container images built by CI SHALL be:
1. Signed using keyless cosign (Sigstore) after each push
2. Attested with SLSA provenance (via `actions/attest-build-provenance` or
   `slsa-github-generator`)
3. Accompanied by SBOMs (generated via syft or buildx `--sbom`) attached as
   attestations
4. Verified at deploy time (cosign verify or ClusterImagePolicy)

#### Scenario: Release image is signed and attested

- GIVEN a release workflow pushes a container image
- WHEN the push completes
- THEN the image is signed with keyless cosign
- AND a SLSA provenance attestation is attached
- AND an SBOM attestation is attached
- AND the deploy step verifies the signature before applying

### Requirement: Deployment Images Pinned by Digest (f042)

All platform images in deployment manifests SHALL be pinned by digest
(kustomize `newDigest`), not mutable `:latest` tags with `imagePullPolicy: Always`.
Dockerfile `FROM` and `COPY --from` references SHALL use `sha256` digest pins.

Runner, MCP, and credential-sidecar images stamped into tenant workloads SHALL
also use digest-pinned references.

#### Scenario: Deployment uses digest-pinned images

- GIVEN the production kustomization
- WHEN images are resolved
- THEN all image references use `@sha256:...` digests
- AND no `:latest` tags are present

### Requirement: Dependency Installation Must Be Verified (f043)

All dependency installations in Dockerfiles and CI workflows SHALL be verified:

1. CodeRabbit CLI SHALL be installed from a specific release binary with a
   pre-committed SHA256 checksum (not `curl | sh` from an unversioned URL)
2. `gh` and `glab` tarballs SHALL be checksum-verified (matching the
   `Dockerfile.openshell` pattern)
3. The failure-masking `|| echo` pattern SHALL be removed from install commands

#### Scenario: Checksum-verified CLI installation

- GIVEN the runner Dockerfile installs the `gh` CLI
- WHEN the binary is downloaded
- THEN its SHA256 checksum is verified against a pinned value
- AND the build fails if the checksum does not match

### Requirement: Credential Sidecar Dependencies Pinned (f057)

Credential sidecar Dockerfiles SHALL pin all pip packages with exact versions
and `--require-hashes`. Git-based builds (e.g., `github-mcp-server`) SHALL
clone at a commit SHA or download a checksummed release binary, not a
repointable git tag.

#### Scenario: Jira sidecar uses pinned dependencies

- GIVEN the Jira credential sidecar Dockerfile
- WHEN `pip install` runs
- THEN exact versions with hashes are specified
- AND no unpinned `pip install mcp-atlassian` exists

---
