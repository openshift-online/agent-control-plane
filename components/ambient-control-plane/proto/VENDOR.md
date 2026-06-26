# Vendored Proto Definitions

Proto files under `openshell/` are vendored from the [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) project.

| Upstream repo | `github.com/NVIDIA/OpenShell` |
|---|---|
| Upstream path | `proto/` |
| Vendored tag | `v0.0.70` |
| Vendored files | `openshell.proto`, `datamodel.proto`, `sandbox.proto` |
| Subset | Sandbox lifecycle, exec, and provider management RPCs (not the full proto surface) |

## Regenerating Go stubs

```bash
cd components/ambient-control-plane/proto && buf generate
```

Output lands in `internal/openshell/grpc/`.

## Updating from upstream

1. Copy the needed `.proto` files from the upstream `proto/` directory at the target tag.
2. Update `go_package` options to match the local import path.
3. Update the tag in this file.
4. Run `buf generate` and commit both proto sources and generated stubs.
