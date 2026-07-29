---
name: upgrade-openshell
description: >
  Upgrade the NVIDIA OpenShell dependency across the platform.
  Handles proto vendoring, gateway/supervisor image bumps, manifest updates,
  Go compilation verification, and cross-component consistency checks.
  Use when: "upgrade openshell", "bump openshell", "update openshell",
  "new openshell version", "upgrade gateway", "bump gateway version".
---

# Upgrade OpenShell

Upgrade the `NVIDIA/OpenShell` dependency across the platform. OpenShell
touches multiple components: proto definitions, Go control plane, API server
gateway defaults, manifests, example YAMLs, and the runner Dockerfile.

## User Input

```text
$ARGUMENTS
```

Parse `$ARGUMENTS` for:
- A target version tag (e.g. `v0.0.94`)
- `--dry-run` flag: analyze only, do not modify files
- If empty, check the latest release at `https://github.com/NVIDIA/OpenShell/releases`

## Scope

OpenShell is consumed by multiple components:

```
components/ambient-control-plane/
  proto/                                    # vendored proto files + generated gRPC stubs
  internal/openshell/grpc/                  # generated Go stubs
  internal/gateway/reconciler.go            # default gateway image tag
  internal/reconciler/gateway_reconciler.go # default gateway image tag
  manifests/gateway/configmap.yaml          # supervisor image tag
  scripts/vendor-proto.sh                   # proto vendoring script

components/ambient-api-server/
  plugins/gateways/handler.go               # default gateway image for API responses

components/runners/ambient-runner/
  Dockerfile                                # supervisor image COPY stage

components/manifests/overlays/*/
  ambient-api-server-*-patch.yaml           # GATEWAY_IMAGE env var

examples/
  **/*.yaml                                 # example gateway manifests
```

## Automated Update Script

The primary tool is `make update-openshell VERSION=<tag>` (runs `scripts/update-openshell.sh`).
This handles:

1. **Proto vendoring** via `components/ambient-control-plane/scripts/vendor-proto.sh`
2. **Gateway image tags** in Go source defaults (`reconciler.go`, `gateway_reconciler.go`)
3. **Supervisor image tag** in `manifests/gateway/configmap.yaml`
4. **Example gateway manifests** under `examples/`

The script does NOT update:
- API server gateway handler default (`plugins/gateways/handler.go`)
- Manifest overlay patches (`components/manifests/overlays/*/`)
- Runner Dockerfile supervisor image
- Spec/doc files referencing versions

## Workflow

### Phase 1 -- Resolve Target Version

Record the current version from `components/ambient-control-plane/proto/VENDOR.md`:

```bash
grep 'Vendored tag' components/ambient-control-plane/proto/VENDOR.md
```

Check the target release exists:
```bash
gh release view <target> --repo NVIDIA/OpenShell
```

If current == target, report "already at target version" and stop.
If `--dry-run`, review the release notes and stop.

### Phase 2 -- Review Release Notes

```bash
gh release view <target> --repo NVIDIA/OpenShell --json body -q .body
```

Look for:
- New proto files that need to be added to `vendor-proto.sh` FILES array
- Removed/renamed proto messages or RPC methods
- Breaking API changes
- New container image names

### Phase 3 -- Run the Update Script

```bash
make update-openshell VERSION=<target>
```

If `vendor-proto.sh` fails due to new imports (e.g. a new `.proto` file),
add the missing file to the `FILES` array in `vendor-proto.sh` and retry.

### Phase 4 -- Update Remaining References

The script misses several files. Update them manually:

```bash
# API server gateway default
sed -i 's/openshell\/gateway:<old>/openshell\/gateway:<new>/g' \
  components/ambient-api-server/plugins/gateways/handler.go

# Manifest overlay patches
sed -i 's/openshell\/gateway:<old>/openshell\/gateway:<new>/g' \
  components/manifests/overlays/kind/ambient-api-server-dev-patch.yaml \
  components/manifests/overlays/openshift-local/ambient-api-server-dev-patch.yaml \
  components/manifests/overlays/hcmais/ambient-api-server-env-patch.yaml \
  components/manifests/overlays/hcmais-dev/ambient-api-server-env-patch.yaml

# Runner Dockerfile supervisor image
sed -i 's/openshell\/supervisor:<old>/openshell\/supervisor:<new>/g' \
  components/runners/ambient-runner/Dockerfile

# E2E test fixtures
sed -i 's/openshell\/gateway:<old>/openshell\/gateway:<new>/g' \
  tests/e2e/fixtures/openshell-cli-test/gateway.yaml
```

Verify no old version references remain:

```bash
rg 'openshell/gateway:<old>' --no-heading
rg 'openshell/supervisor:<old>' --no-heading
```

### Phase 5 -- Verify Compilation

```bash
cd components/ambient-control-plane && go build ./... && go vet ./...
cd components/ambient-api-server && go build ./... && go vet ./...
```

If compilation fails due to proto changes:
- Check if new proto files need vendoring (add to `vendor-proto.sh` FILES)
- Check if message types were renamed/removed (update Go references)
- Check if new RPC methods reference unvendored types (trim from curated subset)

### Phase 6 -- Update VENDOR.md

Ensure `proto/VENDOR.md` lists all vendored files:

```markdown
| Vendored files  | `openshell.proto`, `datamodel.proto`, `sandbox.proto`, `options.proto` |
```

### Phase 7 -- Report

```
UPGRADE COMPLETE: v0.0.83 -> v0.0.94
-------------------------------------
Proto files:        vendored + regenerated
Gateway image:      0.0.83 -> 0.0.94 (all sources, manifests, examples)
Supervisor image:   0.0.83 -> 0.0.94 (configmap, Dockerfile)
Compilation:        PASS (control-plane, api-server)
Remaining old refs: none | <list files with old versions in docs/specs>
```

## Rollback

If the upgrade fails partway:

```bash
git checkout -- components/ambient-control-plane/proto/
git checkout -- components/ambient-control-plane/internal/openshell/grpc/
git checkout -- components/ambient-control-plane/proto/VENDOR.md
```

Then revert any image tag changes in Go source, manifests, and examples.

## Constraints

- `make update-openshell` must be run from the repo root (not a component dir)
- `openshell.proto` is a curated subset -- review the diff and trim RPCs that reference unvendored types
- Image tags use bare semver (no `v` prefix): `0.0.94` not `v0.0.94`
- All image references must match across Go source, manifests, overlays, examples, and Dockerfile
- `buf` must be installed for proto generation
- Never leave partial version bumps (some files at old, some at new)
