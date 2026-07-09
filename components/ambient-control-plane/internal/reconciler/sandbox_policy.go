package reconciler

import (
	"strings"

	sandboxpb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/sandbox/v1"
)

const acpInternalPolicyKey = "_acp_internal"

var acpServiceNames = []string{"ambient-control-plane", "ambient-api-server"}

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

func ensureACPInternalPolicy(policy *sandboxpb.SandboxPolicy, namespace string) *sandboxpb.SandboxPolicy {
	if policy == nil {
		policy = &sandboxpb.SandboxPolicy{}
	}
	if policy.NetworkPolicies == nil {
		policy.NetworkPolicies = make(map[string]*sandboxpb.NetworkPolicyRule)
	}

	if existing, ok := policy.NetworkPolicies[acpInternalPolicyKey]; ok {
		rewriteACPEndpointNamespace(existing, namespace)
	} else {
		policy.NetworkPolicies[acpInternalPolicyKey] = acpInternalRule(namespace)
	}

	return policy
}

func rewriteACPEndpointNamespace(rule *sandboxpb.NetworkPolicyRule, namespace string) {
	for _, ep := range rule.Endpoints {
		ep.Host = rewriteServiceHostNamespace(ep.Host, namespace)
	}
}

func rewriteServiceHostNamespace(host, namespace string) string {
	for _, svc := range acpServiceNames {
		prefix := svc + "."
		if !strings.HasPrefix(host, prefix) {
			continue
		}
		remainder := host[len(prefix):]
		if idx := strings.Index(remainder, ".svc"); idx >= 0 {
			return prefix + namespace + remainder[idx:]
		}
	}
	return host
}
