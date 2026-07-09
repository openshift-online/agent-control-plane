package reconciler

import (
	sandboxpb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/sandbox/v1"
	openshellpb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
)

const acpInternalPolicyKey = "_acp_internal"
const mlflowPolicyKey = "_mlflow_rh"

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

func mlflowRule() *sandboxpb.NetworkPolicyRule {
	return &sandboxpb.NetworkPolicyRule{
		Name: "mlflow-tracking",
		Endpoints: []*sandboxpb.NetworkEndpoint{
			{Host: "mlflow.apps.int.spoke.prod.us-west-2.aws.paas.redhat.com", Port: 443},
		},
		Binaries: []*sandboxpb.NetworkBinary{
			{Path: "/sandbox/.venv/bin/python"},
			{Path: "/sandbox/.venv/bin/python3"},
			{Path: "/sandbox/.venv/bin/uvicorn"},
		},
	}
}

// platformMergeOperations builds the PolicyMergeOperations for platform-required
// network rules that must be present in every sandbox regardless of the agent's
// policy. Currently this includes _acp_internal (control plane + API server
// connectivity) and _mlflow_rh (MLflow tracking).
func platformMergeOperations(namespace string) []*openshellpb.PolicyMergeOperation {
	return []*openshellpb.PolicyMergeOperation{
		{
			Operation: &openshellpb.PolicyMergeOperation_AddRule{
				AddRule: &openshellpb.AddNetworkRule{
					RuleName: acpInternalPolicyKey,
					Rule:     acpInternalRule(namespace),
				},
			},
		},
		{
			Operation: &openshellpb.PolicyMergeOperation_AddRule{
				AddRule: &openshellpb.AddNetworkRule{
					RuleName: mlflowPolicyKey,
					Rule:     mlflowRule(),
				},
			},
		},
	}
}

// mergePlatformRules injects platform-required network rules (_acp_internal,
// _mlflow_rh) directly into the SandboxPolicy's NetworkPolicies map. This
// is called before CreateSandbox so the gateway receives the complete policy
// upfront — no post-hoc UpdateConfig replacement needed.
func mergePlatformRules(policy *sandboxpb.SandboxPolicy, namespace string) *sandboxpb.SandboxPolicy {
	if policy.NetworkPolicies == nil {
		policy.NetworkPolicies = make(map[string]*sandboxpb.NetworkPolicyRule)
	}
	policy.NetworkPolicies[acpInternalPolicyKey] = acpInternalRule(namespace)
	policy.NetworkPolicies[mlflowPolicyKey] = mlflowRule()
	return policy
}
