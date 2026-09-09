package sessions_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/api/openapi"
	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/agents"
	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/projects"
	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/test"
	"github.com/openshift-online/rh-trex-ai/pkg/environments"
)

func TestSessionAgentModelInheritance(t *testing.T) {
	h, client := test.RegisterIntegration(t)
	ctx := h.NewAuthenticatedContext(h.NewRandAccount())
	svcs := &environments.Environment().Services
	project, err := projects.Service(svcs).Create(ctx, &projects.Project{Name: "inherit-" + strings.ToLower(h.NewID())})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := agents.Service(svcs).Create(context.Background(), &agents.Agent{
		Name: "haiku", ProjectId: project.ID, LlmModel: "claude-haiku-4-5@20251001",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name  string
		model *string
		want  string
	}{
		{"inherit", nil, agent.LlmModel},
		{"empty", openapi.PtrString(""), agent.LlmModel},
		{"override", openapi.PtrString("explicit-model"), "explicit-model"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, response, createErr := client.DefaultAPI.ApiAmbientV1SessionsPost(ctx).Session(openapi.Session{
				Name: tc.name, ProjectId: &project.ID, AgentId: &agent.ID, LlmModel: tc.model,
			}).Execute()
			if createErr != nil || response.StatusCode != http.StatusCreated {
				t.Fatalf("create session failed: %v", createErr)
			}
			if result.LlmModel == nil || *result.LlmModel != tc.want {
				t.Fatalf("model = %v, want %q", result.LlmModel, tc.want)
			}
		})
	}
	result, _, createErr := client.DefaultAPI.ApiAmbientV1SessionsPost(ctx).Session(openapi.Session{Name: "no-agent", ProjectId: &project.ID}).Execute()
	if createErr != nil || result.LlmModel == nil || *result.LlmModel != "claude-sonnet-4-6" {
		t.Fatalf("session without an agent lost the default model: %v", createErr)
	}
	_, response, createErr := client.DefaultAPI.ApiAmbientV1SessionsPost(ctx).Session(openapi.Session{
		Name: "wrong-project", ProjectId: openapi.PtrString("another-project"), AgentId: &agent.ID,
	}).Execute()
	if createErr == nil || response.StatusCode != http.StatusNotFound {
		t.Fatalf("agent model must be scoped to the session project: %v", createErr)
	}
}
