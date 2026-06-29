package reconciler

import (
	"encoding/json"
	"testing"

	"github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	"github.com/rs/zerolog"
)

func TestParseAgentDeclaration(t *testing.T) {
	tests := []struct {
		name    string
		yaml    string
		wantErr bool
		check   func(t *testing.T, d *AgentDeclaration)
	}{
		{
			name: "minimal valid declaration",
			yaml: `
name: my-agent
`,
			check: func(t *testing.T, d *AgentDeclaration) {
				if d.Name != "my-agent" {
					t.Errorf("Name = %q, want %q", d.Name, "my-agent")
				}
			},
		},
		{
			name: "full declaration",
			yaml: `
name: code-reviewer
display_name: Code Reviewer
description: Reviews pull requests
prompt: Review this code
entrypoint: /usr/bin/review
repo_url: https://github.com/example/repo
llm_model: claude-sonnet-4-20250514
sandbox_policy: restricted
providers:
  - github
  - jira
environment:
  LOG_LEVEL: debug
  TIMEOUT: "30"
payloads:
  - sandbox_path: /workspace/config
    content: "key: value"
sandbox_template:
  image: quay.io/custom:v1
  resources:
    cpu: "2"
    memory: 4Gi
labels:
  team: platform
annotations:
  owner: alice
`,
			check: func(t *testing.T, d *AgentDeclaration) {
				if d.Name != "code-reviewer" {
					t.Errorf("Name = %q, want %q", d.Name, "code-reviewer")
				}
				if d.DisplayName != "Code Reviewer" {
					t.Errorf("DisplayName = %q, want %q", d.DisplayName, "Code Reviewer")
				}
				if d.Entrypoint != "/usr/bin/review" {
					t.Errorf("Entrypoint = %q, want %q", d.Entrypoint, "/usr/bin/review")
				}
				if len(d.Providers) != 2 || d.Providers[0] != "github" {
					t.Errorf("Providers = %v, want [github jira]", d.Providers)
				}
				if d.Environment["LOG_LEVEL"] != "debug" {
					t.Errorf("Environment[LOG_LEVEL] = %q, want %q", d.Environment["LOG_LEVEL"], "debug")
				}
				if len(d.Payloads) != 1 || d.Payloads[0].SandboxPath != "/workspace/config" {
					t.Errorf("Payloads[0].SandboxPath = %v, want /workspace/config", d.Payloads)
				}
				if d.SandboxTemplate == nil || d.SandboxTemplate.Image != "quay.io/custom:v1" {
					t.Errorf("SandboxTemplate.Image = %v, want quay.io/custom:v1", d.SandboxTemplate)
				}
				if d.Labels["team"] != "platform" {
					t.Errorf("Labels[team] = %q, want %q", d.Labels["team"], "platform")
				}
			},
		},
		{
			name:    "invalid YAML",
			yaml:    `{{{not yaml`,
			wantErr: true,
		},
		{
			name: "payload missing sandbox_path",
			yaml: `
name: bad-agent
payloads:
  - content: "data"
`,
			wantErr: true,
		},
		{
			name: "payload with both content and repo_url",
			yaml: `
name: bad-agent
payloads:
  - sandbox_path: /workspace
    content: "data"
    repo_url: https://example.com
`,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			decl, err := parseAgentDeclaration(tt.yaml)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tt.check != nil {
				tt.check(t, decl)
			}
		})
	}
}

func TestIsConfigMapManaged(t *testing.T) {
	syncer := &ConfigMapSyncer{
		logger: zerolog.Nop(),
	}

	tests := []struct {
		name      string
		agent     *types.Agent
		namespace string
		want      bool
	}{
		{
			name:      "no annotations",
			agent:     &types.Agent{},
			namespace: "ns-1",
			want:      false,
		},
		{
			name: "configmap-managed matching namespace",
			agent: &types.Agent{
				Annotations: mustJSON(map[string]string{
					annotationSource:   annotationSourceCM,
					annotationSourceNS: "ns-1",
				}),
			},
			namespace: "ns-1",
			want:      true,
		},
		{
			name: "configmap-managed different namespace",
			agent: &types.Agent{
				Annotations: mustJSON(map[string]string{
					annotationSource:   annotationSourceCM,
					annotationSourceNS: "ns-2",
				}),
			},
			namespace: "ns-1",
			want:      false,
		},
		{
			name: "not configmap-managed",
			agent: &types.Agent{
				Annotations: mustJSON(map[string]string{
					"some-other": "annotation",
				}),
			},
			namespace: "ns-1",
			want:      false,
		},
		{
			name: "invalid JSON annotations",
			agent: &types.Agent{
				Annotations: "not-json",
			},
			namespace: "ns-1",
			want:      false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := syncer.isConfigMapManaged(tt.agent, tt.namespace)
			if got != tt.want {
				t.Errorf("isConfigMapManaged() = %v, want %v", got, tt.want)
			}
		})
	}
}

func mustJSON(v interface{}) string {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(raw)
}
