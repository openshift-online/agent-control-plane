package reconciler

import (
	sandboxpb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/sandbox/v1"
	openshellpb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
)

const acpInternalPolicyKey = "_acp_internal"
const mlflowPolicyKey = "_mlflow_rh"

// bakedInRuleNames lists the network policy rule keys present in the runner
// image's /etc/openshell/policy.yaml. When an agent specifies a custom
// sandbox policy we must explicitly remove these via RemoveNetworkRule
// because proto3 cannot distinguish "empty network_policies map" from
// "absent" — setting UpdateConfigRequest.Policy alone won't clear them.
var bakedInRuleNames = []string{
	"claude_code_vertex",
	"gcloud",
	"github_ssh_over_https",
	"nvidia_inference",
	"github_rest_api",
	"pypi",
	"vscode",
	"cursor",
	"opencode",
	"atlassian",
	acpInternalPolicyKey,
	mlflowPolicyKey,
}

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

// policyReplacementOperations builds merge operations that replace the
// baked-in image network rules with the agent's policy. The sequence is:
//  1. RemoveNetworkRule for every baked-in rule (clean slate)
//  2. AddRule for each rule in the agent's policy (if any)
//  3. AddRule for platform-required rules (_acp_internal, _mlflow_rh)
func policyReplacementOperations(namespace string, agentPolicy *sandboxpb.SandboxPolicy) []*openshellpb.PolicyMergeOperation {
	var ops []*openshellpb.PolicyMergeOperation

	for _, name := range bakedInRuleNames {
		ops = append(ops, &openshellpb.PolicyMergeOperation{
			Operation: &openshellpb.PolicyMergeOperation_RemoveRule{
				RemoveRule: &openshellpb.RemoveNetworkRule{
					RuleName: name,
				},
			},
		})
	}

	if agentPolicy != nil {
		for key, rule := range agentPolicy.NetworkPolicies {
			ops = append(ops, &openshellpb.PolicyMergeOperation{
				Operation: &openshellpb.PolicyMergeOperation_AddRule{
					AddRule: &openshellpb.AddNetworkRule{
						RuleName: key,
						Rule:     rule,
					},
				},
			})
		}
	}

	ops = append(ops, platformMergeOperations(namespace)...)
	return ops
}
