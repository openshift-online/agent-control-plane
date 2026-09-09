package reconciler

import (
	"testing"

	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/config"
	"github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/types"
)

func TestManagedCursorPathCannotBeOverridden(t *testing.T) {
	r := &ManagedReconciler{cfg: &config.HypershellConfig{}}
	s := types.Session{EnvironmentVariables: `{"ACP_MESSAGE_CURSOR_FILE":"/tmp/other","RESUME_AFTER_SEQ":"999"}`}
	env, err := r.managedEnvironment(s, nil, &ManagedProviderPlan{})
	if err != nil {
		t.Fatal(err)
	}
	if env["ACP_MESSAGE_CURSOR_FILE"] != "/sandbox/workspace/.acp-runtime/message-cursor.json" || env["RESUME_AFTER_SEQ"] != "" {
		t.Fatal("session overrides replaced cursor")
	}
}
