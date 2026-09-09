package sessions

import (
	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/runnerauth"
	"testing"
)

func TestRunnerSessionScope(t *testing.T) {
	project, generation, sandbox, phase := "project-a", "run-a", "sandbox-a", "Running"
	session := &Session{ProjectId: &project, RunnerGeneration: &generation, SandboxName: &sandbox, Phase: &phase}
	session.ID = "session-a"
	claims := runnerauth.Claims{SessionID: "session-a", ProjectID: project, Generation: generation, SandboxName: sandbox}
	if err := validateRunnerSession(session, claims); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		change func(*runnerauth.Claims)
	}{
		{"other session", func(c *runnerauth.Claims) { c.SessionID = "session-b" }},
		{"other project", func(c *runnerauth.Claims) { c.ProjectID = "project-b" }},
		{"old generation", func(c *runnerauth.Claims) { c.Generation = "old-run" }},
		{"other sandbox", func(c *runnerauth.Claims) { c.SandboxName = "sandbox-b" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := claims
			tc.change(&c)
			if validateRunnerSession(session, c) == nil {
				t.Fatal("wrong scope accepted")
			}
		})
	}
	for _, p := range []string{"Stopped", "Failed", "Completed", "Stopping", ""} {
		phase = p
		if validateRunnerSession(session, claims) == nil {
			t.Fatalf("phase %q accepted", p)
		}
	}
	if validateRunnerSession(nil, claims) == nil {
		t.Fatal("missing session accepted")
	}
}
