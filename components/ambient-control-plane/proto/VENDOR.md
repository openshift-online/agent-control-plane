# Vendored Proto Definitions

Proto files under `openshell/` are vendored from the [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) project.

| Upstream repo   | `github.com/NVIDIA/OpenShell` |
|---|---|
| Upstream path   | `proto/` |
| Vendored tag    | `v0.0.70` |
| Vendored commit | `a1b2c3d4e5f6` |
| Vendored files  | `openshell.proto`, `datamodel.proto`, `sandbox.proto` |
| Subset          | Sandbox lifecycle, exec, and provider management RPCs (not the full proto surface) |

## Updating from upstream

Use the vendoring script — it fetches the proto files at the pinned ref, rewrites
`go_package` options to the local import path, stamps the commit SHA in each file
header, updates this file, and runs `buf generate`:

```bash
# From the repo root — accepts a release tag or a full commit SHA
make vendor-openshell-proto REF=v0.0.71

# Or run the script directly from this component
components/ambient-control-plane/scripts/vendor-proto.sh v0.0.71
components/ambient-control-plane/scripts/vendor-proto.sh a1b2c3d4e5f6abc...
```

After running, review the diff and commit both the proto sources and generated stubs.

> **openshell.proto is a curated subset.** The upstream file exposes RPCs beyond
> what ACP needs. After vendoring, review the diff and trim any service methods
> that reference message types from proto files not vendored here.

## Regenerating Go stubs only

If you only need to regenerate the Go stubs without updating proto sources:

```bash
cd components/ambient-control-plane/proto && buf generate
```

Output lands in `internal/openshell/grpc/`.
