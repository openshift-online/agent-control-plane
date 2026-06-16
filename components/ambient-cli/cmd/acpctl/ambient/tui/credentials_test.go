package tui

import (
	"testing"
	"time"

	sdktypes "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"

	"github.com/ambient-code/platform/components/ambient-cli/cmd/acpctl/ambient/tui/views"
)

func TestParseCommand_Credentials(t *testing.T) {
	tests := []struct {
		input string
		kind  CommandKind
	}{
		{"credentials", CmdCredentials},
		{"cred", CmdCredentials},
		{"CRED", CmdCredentials},
		{"Credentials", CmdCredentials},
		{"credentialbindings", CmdCredentialBindings},
		{"cb", CmdCredentialBindings},
		{"CB", CmdCredentialBindings},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			cmd := ParseCommand(tt.input)
			if cmd.Kind != tt.kind {
				t.Errorf("ParseCommand(%q).Kind = %d, want %d", tt.input, cmd.Kind, tt.kind)
			}
		})
	}
}

func TestTabComplete_Credentials(t *testing.T) {
	tests := []struct {
		partial string
		want    []string
	}{
		{"cred", []string{"cred", "credentialbindings", "credentials"}},
		{"cb", []string{"cb"}},
		{"credential", []string{"credentialbindings", "credentials"}},
	}

	for _, tt := range tests {
		t.Run(tt.partial, func(t *testing.T) {
			got := TabComplete(tt.partial, nil, nil)
			if !stringSliceEqual(got, tt.want) {
				t.Errorf("TabComplete(%q) = %v, want %v", tt.partial, got, tt.want)
			}
		})
	}
}

func TestCredentialBindingCount(t *testing.T) {
	credID := "cred-1"
	otherCredID := "cred-2"

	bindings := []sdktypes.RoleBinding{
		{RoleID: "credential:viewer", CredentialID: strPtr(credID), ProjectID: strPtr("proj-1")},
		{RoleID: "credential:viewer", CredentialID: strPtr(credID), ProjectID: strPtr("proj-2")},
		{RoleID: "credential:owner", CredentialID: strPtr(credID)},
		{RoleID: "credential:token-reader", CredentialID: strPtr(credID)},
		{RoleID: "credential:viewer", CredentialID: strPtr(otherCredID), ProjectID: strPtr("proj-1")},
	}

	got := credentialBindingCount(credID, bindings)
	if got != 2 {
		t.Errorf("credentialBindingCount(%q) = %d, want 2 (only credential:viewer)", credID, got)
	}

	got = credentialBindingCount(otherCredID, bindings)
	if got != 1 {
		t.Errorf("credentialBindingCount(%q) = %d, want 1", otherCredID, got)
	}

	got = credentialBindingCount("nonexistent", bindings)
	if got != 0 {
		t.Errorf("credentialBindingCount(\"nonexistent\") = %d, want 0", got)
	}
}

func TestAgentHasDirectBinding(t *testing.T) {
	credID := "cred-1"
	bindings := []sdktypes.RoleBinding{
		{CredentialID: strPtr(credID), AgentID: strPtr("agent-1"), ProjectID: strPtr("proj-1")},
		{CredentialID: strPtr(credID), ProjectID: strPtr("proj-1")},
	}

	if !agentHasDirectBinding("agent-1", credID, bindings) {
		t.Error("expected agent-1 to have direct binding")
	}
	if agentHasDirectBinding("agent-2", credID, bindings) {
		t.Error("expected agent-2 to NOT have direct binding")
	}
	if agentHasDirectBinding("agent-1", "other-cred", bindings) {
		t.Error("expected agent-1 to NOT have binding for other-cred")
	}
}

func TestCredentialDetailLines(t *testing.T) {
	now := time.Now()
	cred := &sdktypes.Credential{
		Name:        "github-pat",
		Provider:    "github",
		Description: "My GitHub PAT",
		URL:         "https://github.com",
		Email:       "dev@example.com",
	}
	fakeSecret := "fake-test-value"
	cred.Token = fakeSecret
	cred.ID = "cred-123"
	cred.CreatedAt = &now
	cred.UpdatedAt = &now

	bindings := []sdktypes.RoleBinding{
		{RoleID: "credential:viewer", CredentialID: strPtr("cred-123"), ProjectID: strPtr("proj-1")},
		{RoleID: "credential:owner", CredentialID: strPtr("cred-123")},
	}

	lines := credentialDetailLines(cred, bindings)

	findKey := func(key string) *views.DetailLine {
		for i := range lines {
			if lines[i].Key == key {
				return &lines[i]
			}
		}
		return nil
	}

	if l := findKey("Name"); l == nil || l.Value != "github-pat" {
		t.Error("expected Name=github-pat in detail lines")
	}
	if l := findKey("Provider"); l == nil || l.Value != "github" {
		t.Error("expected Provider=github in detail lines")
	}
	if l := findKey("Description"); l == nil || l.Value != "My GitHub PAT" {
		t.Error("expected Description in detail lines")
	}
	if l := findKey("URL"); l == nil || l.Value != "https://github.com" {
		t.Error("expected URL in detail lines")
	}
	if l := findKey("Email"); l == nil || l.Value != "dev@example.com" {
		t.Error("expected Email in detail lines")
	}

	// Token must NOT appear
	for _, l := range lines {
		if l.Key == "Token" {
			t.Error("Token must not appear in credential detail lines")
		}
		if l.Value == fakeSecret {
			t.Errorf("Token value leaked in detail line: key=%q value=%q", l.Key, l.Value)
		}
	}
}

func TestCredentialRow(t *testing.T) {
	now := time.Now()
	created := now.Add(-2 * time.Hour)
	cred := sdktypes.Credential{
		Name:        "jira-cloud",
		Provider:    "jira",
		Description: "Jira Cloud credential for CI",
	}
	secretVal := "secret-should-not-appear"
	cred.Token = secretVal
	cred.CreatedAt = &created

	row := views.CredentialRow(cred, 3, now)

	if row[0] != "jira-cloud" {
		t.Errorf("row[0] NAME = %q, want jira-cloud", row[0])
	}
	if row[1] != "jira" {
		t.Errorf("row[1] PROVIDER = %q, want jira", row[1])
	}
	if row[3] != "3" {
		t.Errorf("row[3] BINDINGS = %q, want 3", row[3])
	}
	if row[4] == "" {
		t.Error("row[4] AGE should not be empty")
	}
	// Token must not appear in any column
	for i, cell := range row {
		if cell == secretVal {
			t.Errorf("Token leaked in row column %d", i)
		}
	}
}

func TestCredentialBindingRow(t *testing.T) {
	now := time.Now()
	created := now.Add(-30 * time.Minute)

	binding := sdktypes.RoleBinding{
		RoleID:       "credential:viewer",
		Scope:        "credential",
		CredentialID: strPtr("cred-1"),
		ProjectID:    strPtr("my-project"),
	}
	binding.CreatedAt = &created

	row := views.CredentialBindingRow(binding, "github-pat", "project", "my-project", "direct", now)
	if row[0] != "github-pat" {
		t.Errorf("row[0] CREDENTIAL = %q, want github-pat", row[0])
	}
	if row[1] != "project" {
		t.Errorf("row[1] TYPE = %q, want project", row[1])
	}
	if row[2] != "my-project" {
		t.Errorf("row[2] TARGET = %q, want my-project", row[2])
	}
	if row[3] != "direct" {
		t.Errorf("row[3] STATE = %q, want direct", row[3])
	}
	if row[4] == "" {
		t.Error("row[4] AGE should not be empty for direct binding")
	}

	// Inherited row should have empty age
	inheritedRow := views.CredentialBindingRow(sdktypes.RoleBinding{}, "github-pat", "agent", "bug-fixer", "inherited", now)
	if inheritedRow[3] != "inherited" {
		t.Errorf("inherited row STATE = %q, want inherited", inheritedRow[3])
	}
	if inheritedRow[4] != "" {
		t.Errorf("inherited row AGE = %q, want empty", inheritedRow[4])
	}
}

func TestFetchActiveView_CredentialScoping(t *testing.T) {
	fake := &scopeTrackingClient{}
	m := &AppModel{
		activeView: "credentials",
		fetcher:    fake,
	}
	cmd := m.fetchActiveView()
	if cmd == nil {
		t.Fatal("fetchActiveView() returned nil for credentials view")
	}
	cmd()
	if fake.lastFetchCredentials != true {
		t.Error("expected FetchCredentials to be called")
	}
}

func TestFindCredentialByName(t *testing.T) {
	m := &AppModel{
		cachedCredentials: []sdktypes.Credential{
			{Name: "github-pat", Provider: "github"},
			{Name: "jira-cloud", Provider: "jira"},
		},
	}

	cred := m.findCredentialByName("github-pat")
	if cred == nil {
		t.Fatal("expected to find github-pat")
	}
	if cred.Provider != "github" {
		t.Errorf("Provider = %q, want github", cred.Provider)
	}

	cred = m.findCredentialByName("nonexistent")
	if cred != nil {
		t.Error("expected nil for nonexistent credential")
	}
}

func TestNumberKeyExcludedViews_IncludesCredentials(t *testing.T) {
	if !numberKeyExcludedViews["credentials"] {
		t.Error("credentials should be in numberKeyExcludedViews")
	}
	if !numberKeyExcludedViews["credentialbindings"] {
		t.Error("credentialbindings should be in numberKeyExcludedViews")
	}
}

func TestHintsForView_Credentials(t *testing.T) {
	hints := hintsForView("credentials")
	if len(hints.Resource) == 0 {
		t.Error("credentials view should have resource hints")
	}
	if len(hints.Navigation) == 0 {
		t.Error("credentials view should have navigation hints")
	}

	foundDescribe := false
	foundNew := false
	foundRotate := false
	for _, h := range hints.Resource {
		switch h.Key {
		case "d":
			foundDescribe = true
		case "n":
			foundNew = true
		case "t":
			foundRotate = true
		}
	}
	if !foundDescribe {
		t.Error("credentials hints missing 'd' Describe")
	}
	if !foundNew {
		t.Error("credentials hints missing 'n' New")
	}
	if !foundRotate {
		t.Error("credentials hints missing 't' Rotate Token")
	}
}

func TestHintsForView_CredentialBindings(t *testing.T) {
	hints := hintsForView("credentialbindings")
	if len(hints.Resource) == 0 {
		t.Error("credentialbindings view should have resource hints")
	}

	foundBind := false
	foundAgent := false
	foundUnbind := false
	for _, h := range hints.Resource {
		switch h.Key {
		case "b":
			foundBind = true
		case "a":
			foundAgent = true
		case "ctrl-d":
			foundUnbind = true
		}
	}
	if !foundBind {
		t.Error("credentialbindings hints missing 'b' Bind Project")
	}
	if !foundAgent {
		t.Error("credentialbindings hints missing 'a' Bind Agent")
	}
	if !foundUnbind {
		t.Error("credentialbindings hints missing 'ctrl-d' Unbind")
	}
}

func strPtr(s string) *string {
	return &s
}
