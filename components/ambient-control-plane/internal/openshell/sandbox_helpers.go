package openshell

import (
	"context"
	"encoding/json"
	"fmt"

	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
)

const LogTailLines uint32 = 500

func SandboxPhaseString(phase pb.SandboxPhase) string {
	switch phase {
	case pb.SandboxPhase_SANDBOX_PHASE_READY:
		return "active"
	case pb.SandboxPhase_SANDBOX_PHASE_PROVISIONING:
		return "provisioning"
	case pb.SandboxPhase_SANDBOX_PHASE_ERROR:
		return "error"
	case pb.SandboxPhase_SANDBOX_PHASE_DELETING:
		return "deleting"
	default:
		return "unknown"
	}
}

func PolicyToMap(p interface{ GetVersion() uint32 }) map[string]interface{} {
	raw, err := json.Marshal(p)
	if err != nil {
		return map[string]interface{}{"version": p.GetVersion()}
	}
	var m map[string]interface{}
	if unmarshalErr := json.Unmarshal(raw, &m); unmarshalErr != nil {
		return map[string]interface{}{"version": p.GetVersion()}
	}
	return m
}

func BuildSnapshotPatch(sbx *pb.Sandbox) (map[string]interface{}, error) {
	policy := sbx.GetSpec().GetPolicy()
	sbxStatus := sbx.GetStatus()

	policyEnvelope := map[string]interface{}{
		"version":         policy.GetVersion(),
		"hash":            "",
		"status":          SandboxPhaseString(sbxStatus.GetPhase()),
		"source":          "gateway",
		"config_revision": fmt.Sprintf("%d", sbxStatus.GetCurrentPolicyVersion()),
		"policy":          PolicyToMap(policy),
	}
	policyJSON, err := json.Marshal(policyEnvelope)
	if err != nil {
		return nil, fmt.Errorf("marshal policy: %w", err)
	}

	patch := map[string]interface{}{
		"sandbox_policy_snapshot": string(policyJSON),
	}
	return patch, nil
}

// FetchSandboxLogs reads the gateway's finite log buffer. WatchSandbox is a
// live stream even with all follow flags disabled, so it cannot capture a snapshot.
func (g *GatewayClient) FetchSandboxLogs(ctx context.Context, namespace, sandboxID string, tailLines uint32) ([]map[string]interface{}, error) {
	ctx = g.authContext(ctx, namespace)
	client, err := g.clientForNamespace(ctx, namespace)
	if err != nil {
		return nil, err
	}
	response, err := client.GetSandboxLogs(ctx, &pb.GetSandboxLogsRequest{
		SandboxId: sandboxID,
		Lines:     tailLines,
	})
	if err != nil {
		return nil, err
	}
	entries := make([]map[string]interface{}, 0, len(response.GetLogs()))
	for _, line := range response.GetLogs() {
		entries = append(entries, map[string]interface{}{
			"timestamp": line.GetTimestampMs(),
			"source":    line.GetSource(),
			"level":     line.GetLevel(),
			"module":    line.GetTarget(),
			"message":   line.GetMessage(),
			"fields":    line.GetFields(),
		})
	}
	return entries, nil
}
