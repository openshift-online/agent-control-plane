package reconciler

import (
	"context"
	"encoding/json"
	"fmt"
	sdkclient "github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/client"
	"github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/types"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestManagedContextPreservesInstructionsWithoutRepeatingTask(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/api/ambient/v1/projects/project":
			if _, err := fmt.Fprint(w, `{"id":"project","prompt":"workspace guidance"}`); err != nil {
				t.Error(err)
			}
		case "/api/ambient/v1/projects/project/agents/agent/inbox":
			if _, err := fmt.Fprint(w, `{"total":2,"items":[{"body":"unread context","read":false},{"body":"already read","read":true}]}`); err != nil {
				t.Error(err)
			}
		default:
			t.Errorf("unexpected path %s", req.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	sdk, _ := sdkclient.NewServiceClient(server.URL, "test-service-identity-value")
	session := types.Session{ProjectID: "project", AgentID: "agent", Prompt: "user task must appear once"}
	agent := &types.Agent{ObjectReference: types.ObjectReference{ID: "agent"}, ProjectID: "project", Prompt: "agent guidance"}
	env := map[string]string{"SDK_OPTIONS": `{"max_turns":7,"system_prompt":"custom guidance"}`}
	r := &ManagedReconciler{}
	if err := r.applyManagedContext(context.Background(), sdk, session, agent, env); err != nil {
		t.Fatal(err)
	}
	var options map[string]interface{}
	if err := json.Unmarshal([]byte(env["SDK_OPTIONS"]), &options); err != nil {
		t.Fatal(err)
	}
	text, ok := options["system_prompt"].(string)
	if !ok {
		t.Fatal("system prompt missing")
	}
	for _, wanted := range []string{"workspace guidance", "agent guidance", "unread context", "custom guidance"} {
		if !strings.Contains(text, wanted) {
			t.Fatalf("missing %s", wanted)
		}
	}
	if strings.Contains(text, session.Prompt) || strings.Contains(text, "already read") || options["max_turns"] != float64(7) {
		t.Fatal("task replay or SDK option loss")
	}
	env["SDK_OPTIONS"] = `{"system_prompt":[]}`
	if err := r.applyManagedContext(context.Background(), sdk, session, agent, env); err == nil {
		t.Fatal("invalid SDK options accepted")
	}
}
