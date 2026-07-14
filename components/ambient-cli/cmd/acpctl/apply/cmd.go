// Package apply implements acpctl apply -f / -k for declarative fleet management.
package apply

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/ambient-code/platform/components/ambient-cli/pkg/config"
	"github.com/ambient-code/platform/components/ambient-cli/pkg/connection"
	sdkclient "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/client"
	"github.com/ambient-code/platform/components/ambient-sdk/go-sdk/kustomize"
	sdktypes "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	"github.com/spf13/cobra"
)

var Cmd = &cobra.Command{
	Use:   "apply",
	Short: "Apply declarative Project, Agent, Credential, Policy, RoleBinding, and Gateway manifests",
	Long: `Apply Projects, Agents, Credentials, Policies, RoleBindings, and Gateways from YAML files or a Kustomize directory.

Mirrors kubectl apply semantics: resources are created if they do not exist,
or patched if they do. Output reports created / configured / unchanged per resource.

Supported kinds: Project, Agent, Credential, Policy, RoleBinding, Gateway

File format (one or more documents separated by ---):

  kind: Project
  name: my-project
  description: "..."
  prompt: |
    Workspace context injected into every agent start.
  labels:
    env: dev
  annotations:
    ambient.io/summary: ""

  ---

  kind: Agent
  name: lead
  prompt: |
    You are the Lead...
  labels:
    ambient.io/ready: "true"
  annotations:
    work.ambient.io/current-task: ""
  payloads:
    - sandbox_path: /workspace/config.yaml
      content: |
        key: value
  inbox:
    - from_name: platform-bootstrap
      body: |
        First start. Bootstrap: read project annotations...

Examples:

  acpctl apply -f .ambient/teams/base/
  acpctl apply -f .ambient/teams/base/lead.yaml
  acpctl apply -k .ambient/teams/overlays/dev/
  acpctl apply -k .ambient/teams/overlays/prod/ --dry-run
  cat lead.yaml | acpctl apply -f -

Credential example:

  kind: Credential
  name: my-gitlab-pat
  provider: gitlab
  token: $GITLAB_PAT
  url: https://gitlab.myco.com
  labels:
    team: platform

RoleBinding example:

  kind: RoleBinding
  role: credential:token-reader
  scope: credential
  scope_id: my-gitlab-pat
  user_id: lead
`,
	RunE: run,
}

var applyArgs struct {
	file         string
	kustomize    string
	dryRun       bool
	outputFormat string
	project      string
}

func init() {
	Cmd.Flags().StringVarP(&applyArgs.file, "filename", "f", "", "File, directory, or - for stdin")
	Cmd.Flags().StringVarP(&applyArgs.kustomize, "kustomize", "k", "", "Kustomize directory")
	Cmd.Flags().BoolVar(&applyArgs.dryRun, "dry-run", false, "Print what would be applied without making API calls")
	Cmd.Flags().StringVarP(&applyArgs.outputFormat, "output", "o", "", "Output format: json")
	Cmd.Flags().StringVar(&applyArgs.project, "project", "", "Override project context for Agent resources")
}

type applyResult struct {
	Kind   string `json:"kind"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

func run(cmd *cobra.Command, _ []string) error {
	if applyArgs.file == "" && applyArgs.kustomize == "" {
		return fmt.Errorf("one of -f or -k is required")
	}
	if applyArgs.file != "" && applyArgs.kustomize != "" {
		return fmt.Errorf("-f and -k are mutually exclusive")
	}

	var docs []kustomize.Resource
	var err error

	if applyArgs.kustomize != "" {
		docs, err = kustomize.LoadKustomize(applyArgs.kustomize)
	} else {
		docs, err = kustomize.LoadFile(applyArgs.file)
	}
	if err != nil {
		return err
	}

	if applyArgs.dryRun {
		return printDryRun(cmd, docs)
	}

	factory, err := connection.NewClientFactory()
	if err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	projectName := applyArgs.project
	if projectName == "" {
		projectName = cfg.GetProject()
	}

	ctx, cancel := context.WithTimeout(context.Background(), cfg.GetRequestTimeout())
	defer cancel()

	client, err := factory.ForProject(projectName)
	if err != nil {
		return err
	}

	var results []applyResult
	for _, doc := range docs {
		var result applyResult
		switch strings.ToLower(doc.Kind) {
		case "project":
			result, err = applyProject(ctx, client, doc)
		case "agent":
			result, err = applyAgent(ctx, client, doc, projectName, factory)
		case "policy":
			result, err = applyPolicy(ctx, client, doc, projectName, factory)
		case "credential":
			result, err = applyCredential(ctx, client, doc)
		case "provider":
			result, err = applyProvider(ctx, client, doc)
		case "rolebinding":
			result, err = applyRoleBinding(ctx, client, doc)
		case "gateway":
			result, err = applyGateway(ctx, client, doc)
		default:
			fmt.Fprintf(cmd.ErrOrStderr(), "warning: unknown kind %q — skipping\n", doc.Kind)
			continue
		}
		if err != nil {
			return fmt.Errorf("apply %s/%s: %w", strings.ToLower(doc.Kind), docDisplayName(doc), err)
		}
		results = append(results, result)

		if applyArgs.outputFormat != "json" {
			displayName := result.Name
			if displayName == "" {
				displayName = result.Kind
			}
			fmt.Fprintf(cmd.OutOrStdout(), "%s/%s %s\n",
				strings.ToLower(result.Kind), displayName, result.Status)
		}
	}

	if applyArgs.outputFormat == "json" {
		enc := json.NewEncoder(cmd.OutOrStdout())
		enc.SetIndent("", "  ")
		return enc.Encode(results)
	}
	return nil
}

func applyProject(ctx context.Context, client *sdkclient.Client, doc kustomize.Resource) (applyResult, error) {
	existing, err := client.Projects().Get(ctx, doc.Name)
	if err != nil {
		builder := sdktypes.NewProjectBuilder().Name(doc.Name)
		if doc.Description != "" {
			builder = builder.Description(doc.Description)
		}
		if doc.Prompt != "" {
			builder = builder.Prompt(doc.Prompt)
		}
		proj, buildErr := builder.Build()
		if buildErr != nil {
			return applyResult{}, buildErr
		}
		if _, createErr := client.Projects().Create(ctx, proj); createErr != nil {
			return applyResult{}, createErr
		}
		if len(doc.Labels) > 0 || len(doc.Annotations) > 0 {
			patch := map[string]any{}
			if len(doc.Labels) > 0 {
				patch["labels"] = marshalStringMap(doc.Labels)
			}
			if len(doc.Annotations) > 0 {
				patch["annotations"] = marshalStringMap(doc.Annotations)
			}
			if _, patchErr := client.Projects().Update(ctx, doc.Name, patch); patchErr != nil {
				return applyResult{}, patchErr
			}
		}
		return applyResult{Kind: "Project", Name: doc.Name, Status: "created"}, nil
	}

	patch := buildProjectPatch(existing, doc)
	if len(patch) == 0 {
		return applyResult{Kind: "Project", Name: doc.Name, Status: "unchanged"}, nil
	}
	if _, err = client.Projects().Update(ctx, doc.Name, patch); err != nil {
		return applyResult{}, err
	}
	return applyResult{Kind: "Project", Name: doc.Name, Status: "configured"}, nil
}

func applyCredential(ctx context.Context, client *sdkclient.Client, doc kustomize.Resource) (applyResult, error) {
	existing, err := client.Credentials().Get(ctx, doc.Name)
	if err != nil {
		token := os.ExpandEnv(doc.Token)
		builder := sdktypes.NewCredentialBuilder().
			Name(doc.Name).
			Provider(doc.Provider)
		if token != "" {
			builder = builder.Token(token)
		}
		if doc.Description != "" {
			builder = builder.Description(doc.Description)
		}
		if doc.URL != "" {
			builder = builder.URL(doc.URL)
		}
		if doc.Email != "" {
			builder = builder.Email(doc.Email)
		}
		if len(doc.Labels) > 0 {
			builder = builder.Labels(marshalStringMap(doc.Labels))
		}
		if len(doc.Annotations) > 0 {
			builder = builder.Annotations(marshalStringMap(doc.Annotations))
		}
		cred, buildErr := builder.Build()
		if buildErr != nil {
			return applyResult{}, buildErr
		}
		if _, createErr := client.Credentials().Create(ctx, cred); createErr != nil {
			return applyResult{}, createErr
		}
		return applyResult{Kind: "Credential", Name: doc.Name, Status: "created"}, nil
	}

	patch, changed := buildCredentialPatch(existing, doc)
	if !changed {
		return applyResult{Kind: "Credential", Name: doc.Name, Status: "unchanged"}, nil
	}
	if _, err = client.Credentials().Update(ctx, existing.ID, patch); err != nil {
		return applyResult{}, err
	}
	return applyResult{Kind: "Credential", Name: doc.Name, Status: "configured"}, nil
}

func buildCredentialPatch(existing *sdktypes.Credential, doc kustomize.Resource) (map[string]any, bool) {
	changed := false
	patch := sdktypes.NewCredentialPatchBuilder()
	if doc.Description != "" && doc.Description != existing.Description {
		patch = patch.Description(doc.Description)
		changed = true
	}
	if doc.URL != "" && doc.URL != existing.URL {
		patch = patch.URL(doc.URL)
		changed = true
	}
	if doc.Email != "" && doc.Email != existing.Email {
		patch = patch.Email(doc.Email)
		changed = true
	}
	token := os.ExpandEnv(doc.Token)
	if token != "" && token != existing.Token {
		patch = patch.Token(token)
		changed = true
	}
	if len(doc.Labels) > 0 && marshalStringMap(doc.Labels) != existing.Labels {
		patch = patch.Labels(marshalStringMap(doc.Labels))
		changed = true
	}
	if len(doc.Annotations) > 0 && marshalStringMap(doc.Annotations) != existing.Annotations {
		patch = patch.Annotations(marshalStringMap(doc.Annotations))
		changed = true
	}
	return patch.Build(), changed
}

// ── Provider ─────────────────────────────────────────────────────────────────

func applyProvider(ctx context.Context, client *sdkclient.Client, doc kustomize.Resource) (applyResult, error) {
	existing, err := client.Providers().List(ctx, &sdktypes.ListOptions{
		Search: fmt.Sprintf("name = '%s'", doc.Name),
		Size:   1,
	})
	if err != nil {
		return applyResult{}, fmt.Errorf("listing providers: %w", err)
	}
	if existing != nil && len(existing.Items) > 0 {
		prov := existing.Items[0]
		patch := map[string]any{}
		if doc.Type != "" && doc.Type != prov.Type {
			patch["type"] = doc.Type
		}
		if doc.Secret != "" && doc.Secret != prov.Secret {
			patch["secret"] = doc.Secret
		}
		if len(doc.Labels) > 0 {
			patch["labels"] = marshalStringMap(doc.Labels)
		}
		if len(doc.Annotations) > 0 {
			patch["annotations"] = marshalStringMap(doc.Annotations)
		}
		if len(patch) == 0 {
			return applyResult{Kind: "Provider", Name: doc.Name, Status: "unchanged"}, nil
		}
		if _, err = client.Providers().Update(ctx, prov.ID, patch); err != nil {
			return applyResult{}, err
		}
		return applyResult{Kind: "Provider", Name: doc.Name, Status: "configured"}, nil
	}

	provType := doc.Type
	if provType == "" {
		provType = doc.Name
	}
	builder := sdktypes.NewProviderBuilder().
		Name(doc.Name).
		ProjectID(client.Project()).
		Type(provType)
	if doc.Secret != "" {
		builder = builder.Secret(doc.Secret)
	}
	if len(doc.Labels) > 0 {
		builder = builder.Labels(marshalStringMap(doc.Labels))
	}
	if len(doc.Annotations) > 0 {
		builder = builder.Annotations(marshalStringMap(doc.Annotations))
	}
	prov, buildErr := builder.Build()
	if buildErr != nil {
		return applyResult{}, buildErr
	}
	if _, createErr := client.Providers().Create(ctx, prov); createErr != nil {
		return applyResult{}, createErr
	}
	return applyResult{Kind: "Provider", Name: doc.Name, Status: "created"}, nil
}

// ── RoleBinding ──────────────────────────────────────────────────────────────

func applyRoleBinding(ctx context.Context, client *sdkclient.Client, doc kustomize.Resource) (applyResult, error) {
	displayName := roleBindingDisplayName(doc)

	if doc.Role == "" {
		return applyResult{}, fmt.Errorf("role is required")
	}
	if doc.Scope == "" {
		return applyResult{}, fmt.Errorf("scope is required")
	}
	if doc.ScopeID == "" {
		return applyResult{}, fmt.Errorf("scope_id is required")
	}
	if doc.UserID == "" {
		return applyResult{}, fmt.Errorf("user_id is required")
	}

	roleID, err := resolveRoleID(ctx, client, doc.Role)
	if err != nil {
		return applyResult{}, err
	}

	scopeFK, err := resolveScopeFK(ctx, client, doc.Scope, doc.ScopeID)
	if err != nil {
		return applyResult{}, err
	}

	opts := sdktypes.NewListOptions().Size(100).Build()
	existing, err := client.RoleBindings().List(ctx, opts)
	if err != nil {
		return applyResult{}, fmt.Errorf("list role-bindings: %w", err)
	}

	for _, rb := range existing.Items {
		if rb.RoleID == roleID &&
			rb.Scope == doc.Scope &&
			ptrEquals(rb.UserID, doc.UserID) &&
			scopeFKMatches(rb, doc.Scope, scopeFK) {
			return applyResult{Kind: "RoleBinding", Name: displayName, Status: "unchanged"}, nil
		}
	}

	builder := sdktypes.NewRoleBindingBuilder().
		RoleID(roleID).
		Scope(doc.Scope).
		UserID(doc.UserID)

	switch doc.Scope {
	case "credential":
		builder = builder.CredentialID(scopeFK)
	case "project":
		builder = builder.ProjectID(scopeFK)
	case "agent":
		builder = builder.AgentID(scopeFK)
	case "session":
		builder = builder.SessionID(scopeFK)
	}

	rb, buildErr := builder.Build()
	if buildErr != nil {
		return applyResult{}, buildErr
	}
	if _, createErr := client.RoleBindings().Create(ctx, rb); createErr != nil {
		return applyResult{}, fmt.Errorf("create role-binding: %w", createErr)
	}
	return applyResult{Kind: "RoleBinding", Name: displayName, Status: "created"}, nil
}

func resolveRoleID(ctx context.Context, client *sdkclient.Client, roleName string) (string, error) {
	opts := sdktypes.NewListOptions().Size(100).
		Search(fmt.Sprintf("name = '%s'", roleName)).Build()
	list, err := client.Roles().List(ctx, opts)
	if err != nil {
		return "", fmt.Errorf("search roles for %q: %w", roleName, err)
	}
	for _, r := range list.Items {
		if r.Name == roleName {
			return r.ID, nil
		}
	}
	return "", fmt.Errorf("role %q not found", roleName)
}

func resolveScopeFK(ctx context.Context, client *sdkclient.Client, scope, scopeID string) (string, error) {
	switch scope {
	case "credential":
		return resolveCredentialID(ctx, client, scopeID)
	case "project":
		proj, err := client.Projects().Get(ctx, scopeID)
		if err != nil {
			return "", fmt.Errorf("resolve project %q: %w", scopeID, err)
		}
		return proj.ID, nil
	case "agent":
		return resolveAgentID(ctx, client, scopeID)
	case "session":
		return resolveSessionID(ctx, client, scopeID)
	default:
		return "", fmt.Errorf("unsupported scope %q", scope)
	}
}

func resolveCredentialID(ctx context.Context, client *sdkclient.Client, nameOrID string) (string, error) {
	cred, err := client.Credentials().Get(ctx, nameOrID)
	if err == nil {
		return cred.ID, nil
	}
	var apiErr *sdktypes.APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != 404 {
		return "", fmt.Errorf("resolve credential %q: %w", nameOrID, err)
	}
	opts := sdktypes.NewListOptions().Size(100).
		Search(fmt.Sprintf("name = '%s'", nameOrID)).Build()
	list, err := client.Credentials().List(ctx, opts)
	if err != nil {
		return "", fmt.Errorf("search credentials for %q: %w", nameOrID, err)
	}
	var matches []sdktypes.Credential
	for _, c := range list.Items {
		if c.Name == nameOrID {
			matches = append(matches, c)
		}
	}
	if len(matches) == 0 {
		return "", fmt.Errorf("credential %q not found", nameOrID)
	}
	if len(matches) == 1 {
		return matches[0].ID, nil
	}
	var ids []string
	for _, m := range matches {
		ids = append(ids, m.ID)
	}
	return "", fmt.Errorf("multiple credentials named %q found (%s); use the credential ID instead", nameOrID, strings.Join(ids, ", "))
}

func resolveAgentID(ctx context.Context, client *sdkclient.Client, nameOrID string) (string, error) {
	agent, err := client.Agents().Get(ctx, nameOrID)
	if err == nil {
		return agent.ID, nil
	}
	var apiErr *sdktypes.APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != 404 {
		return "", fmt.Errorf("resolve agent %q: %w", nameOrID, err)
	}
	opts := sdktypes.NewListOptions().Size(100).
		Search(fmt.Sprintf("name = '%s'", nameOrID)).Build()
	list, err := client.Agents().List(ctx, opts)
	if err != nil {
		return "", fmt.Errorf("search agents for %q: %w", nameOrID, err)
	}
	for _, a := range list.Items {
		if a.Name == nameOrID {
			return a.ID, nil
		}
	}
	return "", fmt.Errorf("agent %q not found", nameOrID)
}

func resolveSessionID(ctx context.Context, client *sdkclient.Client, nameOrID string) (string, error) {
	sess, err := client.Sessions().Get(ctx, nameOrID)
	if err == nil {
		return sess.ID, nil
	}
	var apiErr *sdktypes.APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != 404 {
		return "", fmt.Errorf("resolve session %q: %w", nameOrID, err)
	}
	opts := sdktypes.NewListOptions().Size(100).
		Search(fmt.Sprintf("name = '%s'", nameOrID)).Build()
	list, err := client.Sessions().List(ctx, opts)
	if err != nil {
		return "", fmt.Errorf("search sessions for %q: %w", nameOrID, err)
	}
	for _, s := range list.Items {
		if s.Name == nameOrID {
			return s.ID, nil
		}
	}
	return "", fmt.Errorf("session %q not found", nameOrID)
}

func scopeFKMatches(rb sdktypes.RoleBinding, scope, fk string) bool {
	switch scope {
	case "credential":
		return ptrEquals(rb.CredentialID, fk)
	case "project":
		return ptrEquals(rb.ProjectID, fk)
	case "agent":
		return ptrEquals(rb.AgentID, fk)
	case "session":
		return ptrEquals(rb.SessionID, fk)
	}
	return false
}

func ptrEquals(p *string, v string) bool {
	return p != nil && *p == v
}

func roleBindingDisplayName(doc kustomize.Resource) string {
	return doc.UserID + "\u2192" + doc.ScopeID
}

func docDisplayName(d kustomize.Resource) string {
	if d.Name != "" {
		return d.Name
	}
	if strings.EqualFold(d.Kind, "RoleBinding") {
		return roleBindingDisplayName(d)
	}
	return d.Kind
}

func toSDKPayloads(decls []kustomize.PayloadDecl) []sdktypes.Payload {
	out := make([]sdktypes.Payload, len(decls))
	for i, d := range decls {
		out[i] = sdktypes.Payload{
			SandboxPath: d.SandboxPath,
			Content:     d.Content,
			RepoURL:     d.RepoURL,
			Ref:         d.Ref,
		}
	}
	return out
}

func marshalStringMap(m map[string]string) string {
	if len(m) == 0 {
		return ""
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func buildProjectPatch(existing *sdktypes.Project, doc kustomize.Resource) map[string]any {
	patch := map[string]any{}
	if doc.Description != "" && doc.Description != existing.Description {
		patch["description"] = doc.Description
	}
	if doc.Prompt != "" && doc.Prompt != existing.Prompt {
		patch["prompt"] = doc.Prompt
	}
	if len(doc.Labels) > 0 {
		patch["labels"] = marshalStringMap(doc.Labels)
	}
	if len(doc.Annotations) > 0 {
		patch["annotations"] = marshalStringMap(doc.Annotations)
	}
	return patch
}

func applyAgent(ctx context.Context, client *sdkclient.Client, doc kustomize.Resource, projectName string, factory *connection.ClientFactory) (applyResult, error) {
	projClient := client
	if factory != nil {
		if pc, err := factory.ForProject(projectName); err == nil {
			projClient = pc
		}
	}

	project, err := projClient.Projects().Get(ctx, projectName)
	if err != nil {
		return applyResult{}, fmt.Errorf("project %q not found: %w", projectName, err)
	}

	existing, err := projClient.Agents().GetInProject(ctx, project.ID, doc.Name)
	if err != nil {
		builder := sdktypes.NewAgentBuilder().
			ProjectID(project.ID).
			Name(doc.Name)
		if doc.Prompt != "" {
			builder = builder.Prompt(doc.Prompt)
		}
		if len(doc.Providers) > 0 {
			builder = builder.Providers(doc.Providers)
		}
		if len(doc.Payloads) > 0 {
			builder = builder.Payloads(toSDKPayloads(doc.Payloads))
		}
		if len(doc.Environment) > 0 {
			builder = builder.Environment(doc.Environment)
		}
		if doc.SandboxPolicy != "" {
			builder = builder.SandboxPolicy(doc.SandboxPolicy)
		}
		pa, buildErr := builder.Build()
		if buildErr != nil {
			return applyResult{}, buildErr
		}
		created, createErr := projClient.Agents().CreateInProject(ctx, project.ID, pa)
		if createErr != nil {
			return applyResult{}, createErr
		}
		if len(doc.Labels) > 0 || len(doc.Annotations) > 0 {
			patch := map[string]any{}
			if len(doc.Labels) > 0 {
				patch["labels"] = marshalStringMap(doc.Labels)
			}
			if len(doc.Annotations) > 0 {
				patch["annotations"] = marshalStringMap(doc.Annotations)
			}
			if _, patchErr := projClient.Agents().UpdateInProject(ctx, project.ID, created.ID, patch); patchErr != nil {
				return applyResult{}, patchErr
			}
		}
		if seedErr := seedInbox(ctx, projClient, project.ID, created.ID, doc.Inbox); seedErr != nil {
			return applyResult{}, seedErr
		}
		return applyResult{Kind: "Agent", Name: doc.Name, Status: "created"}, nil
	}

	patch := buildAgentPatch(existing, doc)
	status := "unchanged"
	if len(patch) > 0 {
		if _, err = projClient.Agents().UpdateInProject(ctx, project.ID, existing.ID, patch); err != nil {
			return applyResult{}, err
		}
		status = "configured"
	}
	if seedErr := seedInbox(ctx, projClient, project.ID, existing.ID, doc.Inbox); seedErr != nil {
		return applyResult{}, seedErr
	}
	return applyResult{Kind: "Agent", Name: doc.Name, Status: status}, nil
}

func buildAgentPatch(existing *sdktypes.Agent, doc kustomize.Resource) map[string]any {
	patch := map[string]any{}
	if doc.Prompt != "" && doc.Prompt != existing.Prompt {
		patch["prompt"] = doc.Prompt
	}
	if len(doc.Providers) > 0 {
		patch["providers"] = doc.Providers
	}
	if len(doc.Payloads) > 0 {
		patch["payloads"] = toSDKPayloads(doc.Payloads)
	}
	if len(doc.Environment) > 0 {
		patch["environment"] = doc.Environment
	}
	if doc.SandboxPolicy != "" && doc.SandboxPolicy != existing.SandboxPolicy {
		patch["sandbox_policy"] = doc.SandboxPolicy
	}
	if len(doc.Labels) > 0 {
		patch["labels"] = marshalStringMap(doc.Labels)
	}
	if len(doc.Annotations) > 0 {
		patch["annotations"] = marshalStringMap(doc.Annotations)
	}
	return patch
}

// ── Policy ──────────────────────────────────────────────────────────────────

func applyPolicy(ctx context.Context, client *sdkclient.Client, doc kustomize.Resource, projectName string, factory *connection.ClientFactory) (applyResult, error) {
	projClient := client
	if factory != nil {
		if pc, err := factory.ForProject(projectName); err == nil {
			projClient = pc
		}
	}

	project, err := projClient.Projects().Get(ctx, projectName)
	if err != nil {
		return applyResult{}, fmt.Errorf("project %q not found: %w", projectName, err)
	}

	var specJSON string
	if len(doc.Spec) > 0 {
		b, marshalErr := json.Marshal(doc.Spec)
		if marshalErr != nil {
			return applyResult{}, fmt.Errorf("marshal policy spec: %w", marshalErr)
		}
		specJSON = string(b)
	}

	opts := sdktypes.NewListOptions().Size(100).
		Search(fmt.Sprintf("name = '%s'", doc.Name)).Build()
	existing, err := projClient.Policys().List(ctx, opts)
	if err != nil {
		return applyResult{}, fmt.Errorf("listing policies: %w", err)
	}

	var match *sdktypes.Policy
	if existing != nil {
		for i, p := range existing.Items {
			if p.Name == doc.Name {
				match = &existing.Items[i]
				break
			}
		}
	}

	if match != nil {
		patch := sdktypes.NewPolicyPatchBuilder()
		changed := false
		if specJSON != "" && specJSON != match.Spec {
			sdktypes.PolicyPatchSpec(patch, specJSON)
			changed = true
		}
		if len(doc.Labels) > 0 {
			lbl := marshalStringMap(doc.Labels)
			if lbl != match.Labels {
				patch = patch.Labels(lbl)
				changed = true
			}
		}
		if len(doc.Annotations) > 0 {
			ann := marshalStringMap(doc.Annotations)
			if ann != match.Annotations {
				patch = patch.Annotations(ann)
				changed = true
			}
		}
		if !changed {
			return applyResult{Kind: "Policy", Name: doc.Name, Status: "unchanged"}, nil
		}
		if _, err := projClient.Policys().Update(ctx, match.ID, patch.Build()); err != nil {
			return applyResult{}, err
		}
		return applyResult{Kind: "Policy", Name: doc.Name, Status: "configured"}, nil
	}

	builder := sdktypes.NewPolicyBuilder().
		ProjectID(project.ID).
		Name(doc.Name)
	if specJSON != "" {
		builder = builder.Spec(specJSON)
	}
	if len(doc.Labels) > 0 {
		builder = builder.Labels(marshalStringMap(doc.Labels))
	}
	if len(doc.Annotations) > 0 {
		builder = builder.Annotations(marshalStringMap(doc.Annotations))
	}
	policy, buildErr := builder.Build()
	if buildErr != nil {
		return applyResult{}, buildErr
	}
	if _, createErr := projClient.Policys().Create(ctx, policy); createErr != nil {
		return applyResult{}, createErr
	}
	return applyResult{Kind: "Policy", Name: doc.Name, Status: "created"}, nil
}

func seedInbox(ctx context.Context, client *sdkclient.Client, projectID, agentID string, seeds []kustomize.InboxSeed) error {
	if len(seeds) == 0 {
		return nil
	}
	existing, err := client.Agents().ListInboxInProject(ctx, projectID, agentID)
	if err != nil {
		return nil
	}
	existingSet := make(map[string]bool, len(existing))
	for _, msg := range existing {
		existingSet[msg.FromName+"\x00"+msg.Body] = true
	}
	for _, seed := range seeds {
		key := seed.FromName + "\x00" + seed.Body
		if existingSet[key] {
			continue
		}
		if err := client.Agents().SendInboxInProject(ctx, projectID, agentID, seed.FromName, seed.Body); err != nil {
			return err
		}
	}
	return nil
}

// ── Gateway ─────────────────────────────────────────────────────────────────

func applyGateway(ctx context.Context, client *sdkclient.Client, doc kustomize.Resource) (applyResult, error) {
	existing, err := client.Gateways().List(ctx, &sdktypes.ListOptions{
		Search: fmt.Sprintf("name = '%s'", doc.Name),
		Size:   1,
	})
	if err != nil {
		return applyResult{}, fmt.Errorf("listing gateways: %w", err)
	}
	if existing != nil && len(existing.Items) > 0 {
		gw := existing.Items[0]
		patch := buildGatewayPatch(gw, doc)
		if len(patch) == 0 {
			return applyResult{Kind: "Gateway", Name: doc.Name, Status: "unchanged"}, nil
		}
		if _, err = client.Gateways().Update(ctx, gw.ID, patch); err != nil {
			return applyResult{}, err
		}
		return applyResult{Kind: "Gateway", Name: doc.Name, Status: "configured"}, nil
	}

	builder := sdktypes.NewGatewayBuilder().
		Name(doc.Name).
		ProjectID(client.Project())
	if len(doc.ServerDnsNames) > 0 {
		builder = builder.ServerDnsNames(doc.ServerDnsNames)
	}
	if doc.Image != "" {
		builder = builder.Image(doc.Image)
	}
	if doc.Config != "" {
		builder = builder.Config(doc.Config)
	}
	if len(doc.Labels) > 0 {
		builder = builder.Labels(marshalStringMap(doc.Labels))
	}
	if len(doc.Annotations) > 0 {
		builder = builder.Annotations(marshalStringMap(doc.Annotations))
	}
	if oidc := oidcFromResource(doc); oidc != nil {
		builder = builder.Oidc(oidc)
	}
	gw, buildErr := builder.Build()
	if buildErr != nil {
		return applyResult{}, buildErr
	}
	if _, createErr := client.Gateways().Create(ctx, gw); createErr != nil {
		return applyResult{}, createErr
	}
	return applyResult{Kind: "Gateway", Name: doc.Name, Status: "created"}, nil
}

func buildGatewayPatch(existing sdktypes.Gateway, doc kustomize.Resource) map[string]any {
	patch := sdktypes.NewGatewayPatchBuilder()
	changed := false
	if doc.Image != "" && doc.Image != existing.Image {
		patch = patch.Image(doc.Image)
		changed = true
	}
	if doc.Config != "" && doc.Config != existing.Config {
		patch = patch.Config(doc.Config)
		changed = true
	}
	if len(doc.ServerDnsNames) > 0 && !stringSliceEqual(doc.ServerDnsNames, existing.ServerDnsNames) {
		patch = patch.ServerDnsNames(doc.ServerDnsNames)
		changed = true
	}
	if len(doc.Labels) > 0 && marshalStringMap(doc.Labels) != existing.Labels {
		patch = patch.Labels(marshalStringMap(doc.Labels))
		changed = true
	}
	if len(doc.Annotations) > 0 && marshalStringMap(doc.Annotations) != existing.Annotations {
		patch = patch.Annotations(marshalStringMap(doc.Annotations))
		changed = true
	}
	if oidc := oidcFromResource(doc); oidc != nil {
		patch = patch.Oidc(oidc)
		changed = true
	}
	if !changed {
		return nil
	}
	return patch.Build()
}

func oidcFromResource(doc kustomize.Resource) *sdktypes.GatewayOidc {
	if len(doc.Oidc) == 0 {
		return nil
	}
	oidc := &sdktypes.GatewayOidc{}
	if v, ok := doc.Oidc["issuer"].(string); ok {
		oidc.Issuer = v
	}
	if v, ok := doc.Oidc["audience"].(string); ok {
		oidc.Audience = v
	}
	if v, ok := doc.Oidc["jwks_ttl"].(int); ok {
		oidc.JwksTtl = v
	}
	if v, ok := doc.Oidc["roles_claim"].(string); ok {
		oidc.RolesClaim = v
	}
	if v, ok := doc.Oidc["admin_role"].(string); ok {
		oidc.AdminRole = v
	}
	if v, ok := doc.Oidc["user_role"].(string); ok {
		oidc.UserRole = v
	}
	if v, ok := doc.Oidc["scopes_claim"].(string); ok {
		oidc.ScopesClaim = v
	}
	if oidc.Issuer == "" {
		return nil
	}
	return oidc
}

func stringSliceEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// ── Dry-run ───────────────────────────────────────────────────────────────────

func printDryRun(cmd *cobra.Command, docs []kustomize.Resource) error {
	if applyArgs.outputFormat == "json" {
		results := make([]applyResult, 0, len(docs))
		for _, d := range docs {
			results = append(results, applyResult{Kind: d.Kind, Name: docDisplayName(d), Status: "dry-run"})
		}
		enc := json.NewEncoder(cmd.OutOrStdout())
		enc.SetIndent("", "  ")
		return enc.Encode(results)
	}
	w := cmd.OutOrStdout()
	fmt.Fprintln(w, "dry-run: would apply:")
	for _, d := range docs {
		fmt.Fprintf(w, "  %s/%s\n", strings.ToLower(d.Kind), docDisplayName(d))
	}
	return nil
}

// ── stdin helper ──────────────────────────────────────────────────────────────

func readStdin() ([]byte, error) {
	var buf bytes.Buffer
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		buf.WriteString(scanner.Text())
		buf.WriteByte('\n')
	}
	return buf.Bytes(), scanner.Err()
}

var _ = readStdin
