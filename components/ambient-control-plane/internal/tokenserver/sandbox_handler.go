package tokenserver

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell"
	pb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	"github.com/rs/zerolog"
)

// SandboxGateway is the subset of the gateway client needed by sandbox handlers.
type SandboxGateway interface {
	GetSandbox(ctx context.Context, namespace string, name string) (*pb.SandboxResponse, error)
	WatchSandbox(ctx context.Context, namespace string, req *pb.WatchSandboxRequest) (pb.OpenShell_WatchSandboxClient, error)
}

type sandboxHandler struct {
	gateway SandboxGateway
	logger  zerolog.Logger
}

func (h *sandboxHandler) handlePolicy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	name, namespace := parseSandboxPath(r.URL.Path, "policy")
	if name == "" {
		http.Error(w, "sandbox name required", http.StatusBadRequest)
		return
	}
	if ns := r.URL.Query().Get("namespace"); ns != "" {
		namespace = ns
	}
	if namespace == "" {
		http.Error(w, "namespace query parameter required", http.StatusBadRequest)
		return
	}

	resp, err := h.gateway.GetSandbox(r.Context(), namespace, name)
	if err != nil {
		h.logger.Warn().Err(err).Str("sandbox", name).Str("namespace", namespace).Msg("sandbox policy: gateway error")
		http.Error(w, "failed to get sandbox", http.StatusBadGateway)
		return
	}

	sbx := resp.GetSandbox()
	if sbx == nil {
		http.Error(w, "sandbox not found", http.StatusNotFound)
		return
	}

	policy := sbx.GetSpec().GetPolicy()
	status := sbx.GetStatus()

	result := map[string]interface{}{
		"version":         policy.GetVersion(),
		"hash":            "",
		"status":          openshell.SandboxPhaseString(status.GetPhase()),
		"source":          "gateway",
		"config_revision": fmt.Sprintf("%d", status.GetCurrentPolicyVersion()),
		"policy":          openshell.PolicyToMap(policy),
	}

	w.Header().Set("Content-Type", "application/json")
	if encErr := json.NewEncoder(w).Encode(result); encErr != nil {
		h.logger.Warn().Err(encErr).Msg("sandbox policy: failed to write response")
	}
}

func (h *sandboxHandler) handleLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	name, namespace := parseSandboxPath(r.URL.Path, "logs")
	if name == "" {
		http.Error(w, "sandbox name required", http.StatusBadRequest)
		return
	}
	if ns := r.URL.Query().Get("namespace"); ns != "" {
		namespace = ns
	}
	if namespace == "" {
		http.Error(w, "namespace query parameter required", http.StatusBadRequest)
		return
	}

	// WatchSandbox requires the sandbox UUID, not the name. Resolve it first.
	sbxResp, err := h.gateway.GetSandbox(r.Context(), namespace, name)
	if err != nil {
		h.logger.Warn().Err(err).Str("sandbox", name).Str("namespace", namespace).Msg("sandbox logs: failed to resolve sandbox")
		http.Error(w, "failed to resolve sandbox", http.StatusBadGateway)
		return
	}
	sbx := sbxResp.GetSandbox()
	if sbx == nil {
		http.Error(w, "sandbox not found", http.StatusNotFound)
		return
	}
	sandboxID := sbx.GetMetadata().GetId()

	req := &pb.WatchSandboxRequest{
		Id:           sandboxID,
		FollowLogs:   true,
		FollowEvents: true,
		LogTailLines: 1000,
	}

	stream, err := h.gateway.WatchSandbox(r.Context(), namespace, req)
	if err != nil {
		h.logger.Warn().Err(err).Str("sandbox", name).Str("id", sandboxID).Str("namespace", namespace).Msg("sandbox logs: gateway error")
		http.Error(w, "failed to open log stream", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	rc := http.NewResponseController(w)
	if err := rc.SetWriteDeadline(time.Time{}); err != nil {
		h.logger.Warn().Err(err).Msg("sandbox logs: failed to clear write deadline")
	}

	for {
		event, recvErr := stream.Recv()
		if recvErr == io.EOF {
			return
		}
		if recvErr != nil {
			h.logger.Debug().Err(recvErr).Str("sandbox", name).Msg("sandbox logs: stream ended")
			return
		}

		var sseData interface{}
		eventType := "log"

		switch p := event.Payload.(type) {
		case *pb.SandboxStreamEvent_Log:
			sseData = map[string]interface{}{
				"timestamp": p.Log.GetTimestampMs(),
				"source":    p.Log.GetSource(),
				"level":     p.Log.GetLevel(),
				"module":    p.Log.GetTarget(),
				"message":   p.Log.GetMessage(),
				"fields":    p.Log.GetFields(),
			}
		case *pb.SandboxStreamEvent_Event:
			eventType = "platform_event"
			sseData = map[string]interface{}{
				"timestamp": p.Event.GetTimestampMs(),
				"source":    p.Event.GetSource(),
				"type":      p.Event.GetType(),
				"reason":    p.Event.GetReason(),
				"message":   p.Event.GetMessage(),
				"metadata":  p.Event.GetMetadata(),
			}
		case *pb.SandboxStreamEvent_Warning:
			eventType = "warning"
			sseData = map[string]interface{}{
				"message": p.Warning.GetMessage(),
			}
		case *pb.SandboxStreamEvent_Sandbox:
			eventType = "status"
			sseData = map[string]interface{}{
				"phase": openshell.SandboxPhaseString(p.Sandbox.GetStatus().GetPhase()),
				"name":  p.Sandbox.GetStatus().GetSandboxName(),
			}
		default:
			continue
		}

		jsonBytes, marshalErr := json.Marshal(sseData)
		if marshalErr != nil {
			h.logger.Warn().Err(marshalErr).Msg("sandbox logs: failed to marshal event")
			continue
		}

		if _, writeErr := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", eventType, jsonBytes); writeErr != nil {
			h.logger.Debug().Err(writeErr).Msg("sandbox logs: client disconnected")
			return
		}
		if flushErr := rc.Flush(); flushErr != nil {
			h.logger.Debug().Err(flushErr).Msg("sandbox logs: flush failed")
			return
		}
	}
}

// parseSandboxPath extracts sandbox name from a URL path like /sandbox/{name}/{suffix}.
func parseSandboxPath(urlPath, suffix string) (name, namespace string) {
	urlPath = strings.TrimPrefix(urlPath, "/sandbox/")
	urlPath = strings.TrimSuffix(urlPath, "/"+suffix)
	urlPath = strings.TrimSuffix(urlPath, "/")
	if urlPath == "" || strings.Contains(urlPath, "/") {
		return "", ""
	}
	return urlPath, ""
}
