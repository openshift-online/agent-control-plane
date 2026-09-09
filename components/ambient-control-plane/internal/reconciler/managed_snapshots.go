package reconciler

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell"
	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	sdkclient "github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/client"
	"github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/types"
)

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
	patch, err := openshell.BuildSnapshotPatch(response.GetSandbox())
	if err != nil {
		return nil, fmt.Errorf("build managed sandbox snapshot: %w", err)
	}
	logs, err := r.gateway.FetchSandboxLogs(snapshotCtx, target, response.GetSandbox().GetMetadata().GetId(), openshell.LogTailLines)
	if err != nil {
		return nil, fmt.Errorf("collect managed sandbox logs: %w", err)
	}
	if logs == nil {
		logs = []map[string]interface{}{}
	}
	data, err := json.Marshal(logs)
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
