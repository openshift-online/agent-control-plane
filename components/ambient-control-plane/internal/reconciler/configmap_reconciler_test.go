package reconciler

import (
	"encoding/json"
	"testing"

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
		name        string
		annotations string
		namespace   string
		want        bool
	}{
		{
			name:        "empty annotations",
			annotations: "",
			namespace:   "ns-1",
			want:        false,
		},
		{
			name: "configmap-managed matching namespace",
			annotations: mustJSON(map[string]string{
				annotationSource:   annotationSourceCM,
				annotationSourceNS: "ns-1",
			}),
			namespace: "ns-1",
			want:      true,
		},
		{
			name: "configmap-managed different namespace",
			annotations: mustJSON(map[string]string{
				annotationSource:   annotationSourceCM,
				annotationSourceNS: "ns-2",
			}),
			namespace: "ns-1",
			want:      false,
		},
		{
			name: "not configmap-managed",
			annotations: mustJSON(map[string]string{
				"some-other": "annotation",
			}),
			namespace: "ns-1",
			want:      false,
		},
		{
			name:        "invalid JSON annotations",
			annotations: "not-json",
			namespace:   "ns-1",
			want:        false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := syncer.isConfigMapManaged(tt.annotations, tt.namespace)
			if got != tt.want {
				t.Errorf("isConfigMapManaged() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestParsePolicyDeclaration(t *testing.T) {
	tests := []struct {
		name     string
		yaml     string
		wantName string
		wantErr  bool
		check    func(t *testing.T, spec map[string]interface{})
	}{
		{
			name:     "minimal policy",
			yaml:     "name: my-policy\n",
			wantName: "my-policy",
			check: func(t *testing.T, spec map[string]interface{}) {
				if len(spec) != 0 {
					t.Errorf("expected empty spec, got %v", spec)
				}
			},
		},
		{
			name: "full policy with network_policies",
			yaml: `
name: restricted-github-only
network_policies:
  github_api:
    endpoints:
      - host: api.github.com
        port: 443
filesystem:
  read_write:
    - /sandbox
    - /tmp
process:
  run_as_user: sandbox
`,
			wantName: "restricted-github-only",
			check: func(t *testing.T, spec map[string]interface{}) {
				if _, ok := spec["network_policies"]; !ok {
					t.Error("expected network_policies in spec")
				}
				if _, ok := spec["filesystem"]; !ok {
					t.Error("expected filesystem in spec")
				}
				if _, ok := spec["process"]; !ok {
					t.Error("expected process in spec")
				}
				if _, ok := spec["name"]; ok {
					t.Error("name should be stripped from spec")
				}
			},
		},
		{
			name:     "missing name",
			yaml:     "filesystem:\n  read_write:\n    - /tmp\n",
			wantName: "",
		},
		{
			name:    "invalid YAML",
			yaml:    "{{{not yaml",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			name, spec, err := parsePolicyDeclaration(tt.yaml)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if name != tt.wantName {
				t.Errorf("name = %q, want %q", name, tt.wantName)
			}
			if tt.check != nil {
				tt.check(t, spec)
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

func TestValidateResourceName(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{
			name:    "valid lowercase",
			input:   "my-agent",
			wantErr: false,
		},
		{
			name:    "valid single char",
			input:   "a",
			wantErr: false,
		},
		{
			name:    "valid with numbers",
			input:   "agent-123",
			wantErr: false,
		},
		{
			name:    "valid all numbers",
			input:   "123",
			wantErr: false,
		},
		{
			name:    "invalid uppercase",
			input:   "My-Agent",
			wantErr: true,
		},
		{
			name:    "invalid starts with hyphen",
			input:   "-agent",
			wantErr: true,
		},
		{
			name:    "invalid ends with hyphen",
			input:   "agent-",
			wantErr: true,
		},
		{
			name:    "invalid special chars",
			input:   "agent_name",
			wantErr: true,
		},
		{
			name:    "invalid single quote (SQL injection attempt)",
			input:   "agent' OR '1'='1",
			wantErr: true,
		},
		{
			name:    "invalid spaces",
			input:   "my agent",
			wantErr: true,
		},
		{
			name:    "empty string",
			input:   "",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateResourceName(tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateResourceName(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
			}
		})
	}
}
