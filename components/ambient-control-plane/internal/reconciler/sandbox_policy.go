package reconciler

import (
	sandboxpb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/sandbox/v1"
	openshellpb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
)

const acpInternalPolicyKey = "_acp_internal"

func acpInternalRule(namespace string) *sandboxpb.NetworkPolicyRule {
	return &sandboxpb.NetworkPolicyRule{
		Name: "acp-internal",
		Endpoints: []*sandboxpb.NetworkEndpoint{
			{Host: "ambient-control-plane." + namespace + ".svc", Port: 8080},
			{Host: "ambient-control-plane." + namespace + ".svc.cluster.local", Port: 8080},
			{Host: "ambient-api-server." + namespace + ".svc", Port: 8000},
			{Host: "ambient-api-server." + namespace + ".svc.cluster.local", Port: 8000},
			{Host: "ambient-api-server." + namespace + ".svc", Port: 9000},
			{Host: "ambient-api-server." + namespace + ".svc.cluster.local", Port: 9000},
		},
		Binaries: []*sandboxpb.NetworkBinary{
			{Path: "/sandbox/.venv/bin/python"},
			{Path: "/sandbox/.venv/bin/python3"},
			{Path: "/sandbox/.venv/bin/uvicorn"},
			{Path: "/sandbox/.uv/python/cpython-*/bin/python*"},
		},
	}
}

// acpInternalMergeOperation builds a PolicyMergeOperation that adds the
// _acp_internal network rule using namespace-specific endpoints. The gateway
// applies this additively — existing default policy rules are preserved.
func acpInternalMergeOperation(namespace string) *openshellpb.PolicyMergeOperation {
	return &openshellpb.PolicyMergeOperation{
		Operation: &openshellpb.PolicyMergeOperation_AddRule{
			AddRule: &openshellpb.AddNetworkRule{
				RuleName: acpInternalPolicyKey,
				Rule:     acpInternalRule(namespace),
			},
		},
	}
}
