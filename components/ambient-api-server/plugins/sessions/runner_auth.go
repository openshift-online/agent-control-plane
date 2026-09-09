package sessions

import (
	"fmt"
	"strings"

	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/runnerauth"
)

func validateRunnerSession(session *Session, claims runnerauth.Claims) error {
	if session == nil || session.ID != claims.SessionID || derefStr(session.ProjectId) != claims.ProjectID || derefStr(session.RunnerGeneration) != claims.Generation || derefStr(session.SandboxName) != claims.SandboxName {
		return fmt.Errorf("runner scope does not match session")
	}
	switch strings.ToLower(derefStr(session.Phase)) {
	case "creating", "running":
		return nil
	default:
		return fmt.Errorf("session is not active")
	}
}
