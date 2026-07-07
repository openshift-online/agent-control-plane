package openshell

import (
	"context"
	"encoding/json"
	"io"

	pb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
)

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

func (g *GatewayClient) FetchSandboxLogs(ctx context.Context, namespace, sandboxID string, tailLines uint32) ([]map[string]interface{}, error) {
	req := &pb.WatchSandboxRequest{
		Id:           sandboxID,
		FollowLogs:   false,
		LogTailLines: tailLines,
	}

	stream, err := g.WatchSandbox(ctx, namespace, req)
	if err != nil {
		return nil, err
	}

	var entries []map[string]interface{}
	for {
		event, recvErr := stream.Recv()
		if recvErr == io.EOF {
			break
		}
		if recvErr != nil {
			if len(entries) > 0 {
				return entries, nil
			}
			return nil, recvErr
		}

		if p, ok := event.Payload.(*pb.SandboxStreamEvent_Log); ok {
			entries = append(entries, map[string]interface{}{
				"timestamp": p.Log.GetTimestampMs(),
				"source":    p.Log.GetSource(),
				"level":     p.Log.GetLevel(),
				"module":    p.Log.GetTarget(),
				"message":   p.Log.GetMessage(),
				"fields":    p.Log.GetFields(),
			})
		}
	}
	return entries, nil
}
