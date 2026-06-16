package tui

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/atotto/clipboard"
	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"

	"github.com/ambient-code/platform/components/ambient-cli/cmd/acpctl/ambient/tui/views"
	sdktypes "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
)

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

func (m *AppModel) handleCredentialsMsg(msg CredentialsMsg) (tea.Model, tea.Cmd) {
	m.pollInFlight = false
	m.lastFetch = time.Now()

	if msg.Err != nil {
		errMsg, skipPoll := m.classifyAPIError(msg.Err, "credentials")
		m.lastError = errMsg
		m.skipNextPoll = m.skipNextPoll || skipPoll
		return m, nil
	}

	m.lastError = ""
	m.authExpired = false
	m.cachedCredentials = msg.Credentials
	now := time.Now()

	rows := make([]table.Row, 0, len(msg.Credentials))
	for _, c := range msg.Credentials {
		count := credentialBindingCount(c.ID, m.cachedCredentialBindings)
		row := views.CredentialRow(c, count, now)
		for i := range row {
			row[i] = Sanitize(row[i])
		}
		rows = append(rows, row)
	}
	m.credentialTable.SetRows(rows)

	if m.activeView == "credentials" && m.activeFilter != nil {
		f := m.activeFilter
		m.credentialTable.SetFilter(func(cols []string) bool {
			return f.MatchRow(cols)
		})
	}

	var cmds []tea.Cmd
	if len(msg.Credentials) >= 200 {
		cmds = append(cmds, m.setInfo("Showing first 200 credentials"))
	}

	return m, tea.Batch(cmds...)
}

func (m *AppModel) handleCredentialBindingsMsg(msg CredentialBindingsMsg) (tea.Model, tea.Cmd) {
	if msg.Err != nil {
		errMsg, _ := m.classifyAPIError(msg.Err, "credential bindings")
		m.lastError = errMsg
		return m, nil
	}

	m.lastError = ""
	m.cachedCredentialBindings = msg.Bindings

	if m.activeView == "credentials" {
		m.rebuildCredentialRows()
	}

	if m.activeView == "credentialbindings" {
		m.rebuildCredentialBindingRows()
	}

	return m, nil
}

func (m *AppModel) rebuildCredentialRows() {
	now := time.Now()
	rows := make([]table.Row, 0, len(m.cachedCredentials))
	for _, c := range m.cachedCredentials {
		count := credentialBindingCount(c.ID, m.cachedCredentialBindings)
		row := views.CredentialRow(c, count, now)
		for i := range row {
			row[i] = Sanitize(row[i])
		}
		rows = append(rows, row)
	}
	m.credentialTable.SetRows(rows)
}

func (m *AppModel) rebuildCredentialBindingRows() {
	now := time.Now()
	var rows []table.Row

	credName := m.currentCredential

	for _, b := range m.cachedCredentialBindings {
		if b.CredentialID == nil || *b.CredentialID != m.currentCredentialID {
			continue
		}
		if b.AgentID != nil && *b.AgentID != "" {
			targetName := *b.AgentID
			rows = append(rows, views.CredentialBindingRow(b, credName, "agent", targetName, "direct", now))
		} else if b.ProjectID != nil && *b.ProjectID != "" {
			targetName := *b.ProjectID
			rows = append(rows, views.CredentialBindingRow(b, credName, "project", targetName, "direct", now))

			// Synthesize inherited rows for agents in this project
			// that don't have explicit agent-level bindings.
			for _, agent := range m.cachedAgents {
				if !agentHasDirectBinding(agent.ID, m.currentCredentialID, m.cachedCredentialBindings) {
					rows = append(rows, views.CredentialBindingRow(
						sdktypes.RoleBinding{}, credName, "agent", agent.Name, "inherited", now,
					))
				}
			}
		}
	}

	m.credentialBindingTable.SetRows(rows)
}

func credentialBindingCount(credID string, bindings []sdktypes.RoleBinding) int {
	count := 0
	for _, b := range bindings {
		if b.CredentialID != nil && *b.CredentialID == credID {
			count++
		}
	}
	return count
}

func agentHasDirectBinding(agentID, credentialID string, bindings []sdktypes.RoleBinding) bool {
	for _, b := range bindings {
		if b.CredentialID != nil && *b.CredentialID == credentialID &&
			b.AgentID != nil && *b.AgentID == agentID {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

func (m *AppModel) findCredentialByName(name string) *sdktypes.Credential {
	for i := range m.cachedCredentials {
		if m.cachedCredentials[i].Name == name {
			return &m.cachedCredentials[i]
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Key handlers
// ---------------------------------------------------------------------------

func (m *AppModel) handleCredentialsRune(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "d":
		row := m.credentialTable.SelectedRow()
		if len(row) == 0 {
			return m, nil
		}
		credName := row[0]
		cred := m.findCredentialByName(credName)
		if cred == nil {
			return m, m.setInfo("Credential not found in cache: " + credName)
		}
		detail := credentialDetailLines(cred, m.cachedCredentialBindings)
		m.detailView = views.NewDetailView("Credential: "+credName, detail)
		m.detailView.SetSize(m.width, m.height-10)
		cmd := m.pushView("detail", credName, cred.ID)
		return m, tea.Batch(cmd, m.setInfo("Credential detail: "+credName))

	case "e":
		return m.openEditorForCredential()

	case "n":
		return m.openCredentialCreateForm()

	case "t":
		return m.openTokenRotationPrompt()

	case "y":
		row := m.credentialTable.SelectedRow()
		if len(row) == 0 {
			return m, nil
		}
		credName := row[0]
		cred := m.findCredentialByName(credName)
		if cred == nil {
			return m, m.setInfo("Credential not found in cache: " + credName)
		}
		sanitized := *cred
		sanitized.Token = ""
		data, err := json.MarshalIndent(sanitized, "", "  ")
		if err != nil {
			return m, m.setInfo("JSON marshal error: " + err.Error())
		}
		if err := clipboard.WriteAll(string(data)); err != nil {
			return m, m.setInfo("Clipboard error: " + err.Error())
		}
		return m, m.setInfo("Copied to clipboard")
	}
	return m, nil
}

func (m *AppModel) handleCredentialBindingsRune(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "d":
		row := m.credentialBindingTable.SelectedRow()
		if len(row) == 0 {
			return m, nil
		}
		detail := []views.DetailLine{
			{Key: "Credential", Value: row[0]},
			{Key: "Type", Value: row[1]},
			{Key: "Target", Value: row[2]},
			{Key: "State", Value: row[3]},
			{Key: "Age", Value: row[4]},
		}
		m.detailView = views.NewDetailView("Binding Detail", detail)
		m.detailView.SetSize(m.width, m.height-10)
		cmd := m.pushView("detail", row[2], "")
		return m, cmd

	case "b":
		return m.openBindProjectPrompt()

	case "a":
		return m.openBindAgentPrompt()
	}
	return m, nil
}

// ---------------------------------------------------------------------------
// Credential detail
// ---------------------------------------------------------------------------

func credentialDetailLines(c *sdktypes.Credential, bindings []sdktypes.RoleBinding) []views.DetailLine {
	lines := []views.DetailLine{
		{Key: "ID", Value: c.ID},
		{Key: "Name", Value: c.Name},
		{Key: "Provider", Value: c.Provider},
	}
	if c.Description != "" {
		lines = append(lines, views.DetailLine{Key: "Description", Value: c.Description})
	}
	if c.URL != "" {
		lines = append(lines, views.DetailLine{Key: "URL", Value: c.URL})
	}
	if c.Email != "" {
		lines = append(lines, views.DetailLine{Key: "Email", Value: c.Email})
	}
	if c.CreatedAt != nil {
		lines = append(lines, views.DetailLine{Key: "Created", Value: c.CreatedAt.Format(time.RFC3339)})
	}
	if c.UpdatedAt != nil {
		lines = append(lines, views.DetailLine{Key: "Updated", Value: c.UpdatedAt.Format(time.RFC3339)})
	}

	count := credentialBindingCount(c.ID, bindings)
	lines = append(lines, views.DetailLine{Key: "Bindings", Value: fmt.Sprintf("%d", count)})

	for _, b := range bindings {
		if b.CredentialID == nil || *b.CredentialID != c.ID {
			continue
		}
		target := ""
		if b.AgentID != nil && *b.AgentID != "" {
			project := ""
			if b.ProjectID != nil {
				project = *b.ProjectID
			}
			target = fmt.Sprintf("agent %s in project %s", *b.AgentID, project)
		} else if b.ProjectID != nil && *b.ProjectID != "" {
			target = fmt.Sprintf("project %s", *b.ProjectID)
		}
		if target != "" {
			lines = append(lines, views.DetailLine{Key: "  Binding", Value: target})
		}
	}

	return lines
}

// ---------------------------------------------------------------------------
// Credential create form
// ---------------------------------------------------------------------------

func (m *AppModel) openCredentialCreateForm() (tea.Model, tea.Cmd) {
	var provider, name, token, url, email, description string

	form := huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Provider").
				Options(
					huh.NewOption("github", "github"),
					huh.NewOption("gitlab", "gitlab"),
					huh.NewOption("jira", "jira"),
					huh.NewOption("google", "google"),
					huh.NewOption("kubeconfig", "kubeconfig"),
				).
				Value(&provider),
			huh.NewInput().
				Title("Name").
				Value(&name),
			huh.NewInput().
				Title("Token").
				EchoMode(huh.EchoModePassword).
				Value(&token),
		).Title("1/2 · Required"),
		huh.NewGroup(
			huh.NewInput().
				Title("URL").
				Value(&url),
			huh.NewInput().
				Title("Email").
				Value(&email),
			huh.NewInput().
				Title("Description").
				Value(&description),
		).Title("2/2 · Optional"),
	)
	form.WithWidth(60)
	form.WithShowHelp(true)

	m.formOverlay = form
	m.formTitle = "New Credential"
	m.formOnComplete = func() tea.Cmd {
		builder := sdktypes.NewCredentialBuilder().
			Name(name).
			Provider(provider)
		if token != "" {
			builder = builder.Token(token)
		}
		if url != "" {
			builder = builder.URL(url)
		}
		if email != "" {
			builder = builder.Email(email)
		}
		if description != "" {
			builder = builder.Description(description)
		}
		cred, err := builder.Build()
		if err != nil {
			return m.setInfo("Validation error: " + err.Error())
		}
		return tea.Batch(
			m.client.CreateCredential(cred),
			m.setInfo("Creating credential "+name+"..."),
		)
	}
	return m, m.formOverlay.Init()
}

// ---------------------------------------------------------------------------
// Token rotation
// ---------------------------------------------------------------------------

func (m *AppModel) openTokenRotationPrompt() (tea.Model, tea.Cmd) {
	row := m.credentialTable.SelectedRow()
	if len(row) == 0 {
		return m, nil
	}
	credName := row[0]
	cred := m.findCredentialByName(credName)
	if cred == nil {
		return m, m.setInfo("Credential not found in cache: " + credName)
	}

	credID := cred.ID

	m.promptMode = true
	m.promptInput.Prompt = "New token for " + credName + ": "
	m.promptInput.EchoMode = 1 // password mode
	m.promptInput.Focus()
	m.promptCallback = func(value string) (tea.Model, tea.Cmd) {
		m.promptInput.EchoMode = 0
		if value == "" {
			return m, m.setInfo("Cancelled — no token entered")
		}
		return m, tea.Batch(
			m.client.UpdateCredential(credID, map[string]any{"token": value}),
			m.setInfo("Rotating token for "+credName+"..."),
		)
	}
	return m, nil
}

// ---------------------------------------------------------------------------
// Editor (e key)
// ---------------------------------------------------------------------------

func (m *AppModel) openEditorForCredential() (tea.Model, tea.Cmd) {
	row := m.credentialTable.SelectedRow()
	if len(row) == 0 {
		return m, nil
	}
	credName := row[0]
	cred := m.findCredentialByName(credName)
	if cred == nil {
		return m, m.setInfo("Credential not found in cache: " + credName)
	}

	sanitized := *cred
	sanitized.Token = ""

	return m.openEditorForResource("credential", cred.ID, "", sanitized)
}

// ---------------------------------------------------------------------------
// Bind prompts
// ---------------------------------------------------------------------------

func (m *AppModel) openBindProjectPrompt() (tea.Model, tea.Cmd) {
	credID := m.currentCredentialID
	credName := m.currentCredential
	if credID == "" {
		return m, m.setInfo("No credential context")
	}

	m.promptMode = true
	m.promptInput.Prompt = "Bind " + credName + " to project: "
	m.promptInput.Focus()
	m.promptCallback = func(projectName string) (tea.Model, tea.Cmd) {
		if projectName == "" {
			return m, m.setInfo("Cancelled")
		}
		return m, tea.Batch(
			m.client.CreateBinding(credID, projectName, ""),
			m.setInfo("Binding "+credName+" to project "+projectName+"..."),
		)
	}
	return m, nil
}

func (m *AppModel) openBindAgentPrompt() (tea.Model, tea.Cmd) {
	credID := m.currentCredentialID
	credName := m.currentCredential
	if credID == "" {
		return m, m.setInfo("No credential context")
	}

	m.promptMode = true
	m.promptInput.Prompt = "Project for agent binding: "
	m.promptInput.Focus()
	m.promptCallback = func(projectName string) (tea.Model, tea.Cmd) {
		if projectName == "" {
			return m, m.setInfo("Cancelled")
		}
		m.promptMode = true
		m.promptInput.Prompt = "Agent in " + projectName + ": "
		m.promptInput.Reset()
		m.promptInput.Focus()
		m.promptCallback = func(agentName string) (tea.Model, tea.Cmd) {
			if agentName == "" {
				return m, m.setInfo("Cancelled")
			}
			return m, tea.Batch(
				m.client.CreateBinding(credID, projectName, agentName),
				m.setInfo("Binding "+credName+" to agent "+agentName+" in project "+projectName+"..."),
			)
		}
		return m, nil
	}
	return m, nil
}

// ---------------------------------------------------------------------------
// Credential enter (drill into bindings) and ctrl-d (delete/unbind)
// ---------------------------------------------------------------------------

func (m *AppModel) handleCredentialEnter() (tea.Model, tea.Cmd) {
	row := m.credentialTable.SelectedRow()
	if len(row) == 0 {
		return m, nil
	}
	credName := row[0]
	cred := m.findCredentialByName(credName)
	if cred == nil {
		return m, m.setInfo("Credential not found in cache: " + credName)
	}

	m.currentCredential = credName
	m.currentCredentialID = cred.ID
	m.credentialBindingTable.SetScope(credName)
	cmd := m.pushView("credentialbindings", credName, cred.ID)
	return m, tea.Batch(
		cmd,
		m.client.FetchCredentialBindings(cred.ID),
		m.setInfo("Viewing bindings for "+credName),
	)
}

func (m *AppModel) handleCredentialCtrlD() (tea.Model, tea.Cmd) {
	row := m.credentialTable.SelectedRow()
	if len(row) == 0 {
		return m, nil
	}
	credName := row[0]
	cred := m.findCredentialByName(credName)
	if cred == nil {
		return m, m.setInfo("Credential not found in cache: " + credName)
	}
	credID := cred.ID
	d := views.NewDeleteDialog("credential", credName)
	m.dialog = &d
	m.dialogAction = func(_ string) tea.Cmd {
		return m.client.DeleteCredential(credID)
	}
	return m, nil
}

func (m *AppModel) handleCredentialBindingCtrlD() (tea.Model, tea.Cmd) {
	row := m.credentialBindingTable.SelectedRow()
	if len(row) == 0 {
		return m, nil
	}

	state := row[3]
	if state == "inherited" {
		return m, m.setInfo("Cannot unbind inherited access — remove the project binding instead")
	}

	targetType := row[1]
	target := row[2]

	// Find the backing RoleBinding ID.
	var bindingID string
	for _, b := range m.cachedCredentialBindings {
		if b.CredentialID == nil || *b.CredentialID != m.currentCredentialID {
			continue
		}
		if targetType == "project" && b.ProjectID != nil && *b.ProjectID == target && (b.AgentID == nil || *b.AgentID == "") {
			bindingID = b.ID
			break
		}
		if targetType == "agent" && b.AgentID != nil && *b.AgentID == target {
			bindingID = b.ID
			break
		}
	}

	if bindingID == "" {
		return m, m.setInfo("Binding not found")
	}

	label := fmt.Sprintf("%s from %s %s", m.currentCredential, targetType, target)
	d := views.NewDeleteDialog("binding", label)
	m.dialog = &d
	m.dialogAction = func(_ string) tea.Cmd {
		return m.client.DeleteBinding(bindingID)
	}
	return m, nil
}
