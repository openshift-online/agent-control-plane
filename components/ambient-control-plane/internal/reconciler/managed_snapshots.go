package reconciler

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell"
	policypb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/sandbox/v1"
	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	sdkclient "github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/client"
	"github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/types"
)

// This must match runtimeapi.MaxSnapshotBytes, the API's decoded UTF-8 byte limit.
const managedSnapshotMaxBytes = 2 * 1024 * 1024

// encodeManagedLogSnapshot keeps the newest log entries within the API limit.
// Measure encoded JSON bytes: escaping can make logs larger than their text.
func encodeManagedLogSnapshot(logs []map[string]interface{}) ([]byte, error) {
	if logs == nil {
		logs = []map[string]interface{}{}
	}
	data, err := json.Marshal(logs)
	if err != nil || len(data) <= managedSnapshotMaxBytes {
		return data, err
	}
	omissionRecord := func(count int) json.RawMessage {
		return json.RawMessage(fmt.Sprintf(`{"timestamp":0,"source":"control-plane","level":"WARN","module":"snapshot","message":"Sandbox log entries were omitted because the snapshot reached its size limit.","fields":{"omitted_entries":"%d","max_bytes":"%d"}}`, count, managedSnapshotMaxBytes))
	}
	// Reserve the largest possible omission count, brackets, and one comma.
	warning := omissionRecord(len(logs))
	budget := managedSnapshotMaxBytes - len(warning) - 3
	retained := make([]json.RawMessage, 0, len(logs))
	omitted := 0
	for i := len(logs) - 1; i >= 0; i-- {
		entry, err := json.Marshal(logs[i])
		if err != nil {
			return nil, err
		}
		if len(entry) > managedSnapshotMaxBytes-len(warning)-3 {
			// A single oversized entry must not discard every smaller entry.
			omitted++
			continue
		}
		cost := len(entry)
		if len(retained) > 0 {
			cost++
		}
		if cost > budget {
			omitted += i + 1
			break
		}
		retained = append(retained, entry)
		budget -= cost
	}
	result := make([]json.RawMessage, 0, len(retained)+1)
	result = append(result, omissionRecord(omitted))
	for i := len(retained) - 1; i >= 0; i-- {
		result = append(result, retained[i])
	}
	return json.Marshal(result)
}

// saveManagedSnapshot commits the existing UI policy/log contract before the
// remote runtime changes. It never reads provider credentials or copies the
// sandbox environment into ACP. The returned session carries the new CAS version.
func (r *ManagedReconciler) saveManagedSnapshot(ctx context.Context, sdk *sdkclient.Client, s types.Session, target string, response *pb.SandboxResponse) (*types.Session, error) {
	if err := validateManagedSandbox(s, response); err != nil {
		return nil, err
	}
	// A stopped sandbox may no longer have a pod or its logs. Preserve the
	// successful pre-stop capture when deletion follows a completed stop.
	if response.GetSandbox().GetStatus().GetPhase() == pb.SandboxPhase_SANDBOX_PHASE_STOPPED && s.SandboxLogsSnapshot != "" && s.SandboxPolicySnapshot != "" {
		return &s, nil
	}
	snapshotCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	policy, err := r.gateway.GetSandboxPolicyStatus(snapshotCtx, target, s.SandboxName)
	if err != nil {
		return nil, fmt.Errorf("collect managed sandbox policy: %w", err)
	}
	if policy.GetRevision().GetPolicy() == nil {
		return nil, fmt.Errorf("gateway returned no authored sandbox policy")
	}
	// GetSandbox retains the creation-time policy. Save the current authored
	// revision after callback or user policy changes, without copying secrets.
	sandbox := proto.Clone(response.GetSandbox()).(*pb.Sandbox)
	if sandbox.Spec == nil {
		sandbox.Spec = &pb.SandboxSpec{}
	}
	sandbox.Spec.Policy = proto.Clone(policy.GetRevision().GetPolicy()).(*policypb.SandboxPolicy)
	if policy.GetRevision().GetVersion() > 0 {
		if sandbox.Status == nil {
			sandbox.Status = &pb.SandboxStatus{}
		}
		sandbox.Status.CurrentPolicyVersion = policy.GetRevision().GetVersion()
	}
	patch, err := openshell.BuildSnapshotPatch(sandbox)
	if err != nil {
		return nil, fmt.Errorf("build managed sandbox snapshot: %w", err)
	}
	logs, err := r.gateway.FetchSandboxLogs(snapshotCtx, target, response.GetSandbox().GetMetadata().GetId(), openshell.LogTailLines)
	if err != nil {
		return nil, fmt.Errorf("collect managed sandbox logs: %w", err)
	}
	data, err := encodeManagedLogSnapshot(logs)
	if err != nil {
		return nil, fmt.Errorf("encode managed sandbox logs: %w", err)
	}
	patch["sandbox_logs_snapshot"] = string(data)
	patch["expected_phase"] = s.Phase
	updated, err := r.patchSession(snapshotCtx, sdk, s, patch)
	if err != nil {
		return nil, fmt.Errorf("persist managed sandbox snapshot: %w", err)
	}
	return updated, nil
}
