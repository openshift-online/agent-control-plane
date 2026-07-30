module github.com/openshift-online/agent-control-plane/components/credential-sidecars/entrypoint

go 1.24.4

require github.com/openshift-online/agent-control-plane/components/ambient-mcp v0.0.0

replace github.com/openshift-online/agent-control-plane/components/ambient-mcp => ../../ambient-mcp
