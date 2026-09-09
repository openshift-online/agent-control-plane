package reconciler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"sort"
	"strings"
	"time"

	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell"
	datapb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/datamodel/v1"
	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	sdkclient "github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/client"
	"github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/types"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const managedProviderLabel = "ambient-code.io/managed-provider"
const managedCredentialAnnotation = "ambient-code.io/credential-id"
const managedSessionAnnotation = "ambient-code.io/session-id"
const managedSourceVersionAnnotation = "ambient-code.io/source-version"
const managedRuntimeInputsAnnotation = "ambient-code.io/runtime-inputs-sha256"

// OpenShell keeps provider metadata immutable on update. Mutable ACP state uses
// reserved nonsecret config keys, separate from provider driver settings.
const managedProviderStatePrefix = "acp.internal/"
const managedSourceVersionConfig = managedProviderStatePrefix + "source-version"
const managedRuntimeInputsConfig = managedProviderStatePrefix + "runtime-inputs-sha256"

// ErrBindingsChanged requires the caller to stop runtime access if a provider
// cannot be removed. A failed authorization lookup must also stop active access.
var ErrBindingsChanged = errors.New("managed credential access changed")

type ManagedProviderPlan struct {
	Names             []string
	Environment       map[string]string
	InferenceProvider string
	Payloads          []openshell.Payload
}

type managedProviderGateway interface {
	GetProviderProfile(context.Context, string, *pb.GetProviderProfileRequest) (*pb.ProviderProfileResponse, error)
	ImportProviderProfiles(context.Context, string, *pb.ImportProviderProfilesRequest) (*pb.ImportProviderProfilesResponse, error)
	UpdateProviderProfiles(context.Context, string, *pb.UpdateProviderProfilesRequest) (*pb.UpdateProviderProfilesResponse, error)
	GetProvider(context.Context, string, string) (*pb.ProviderResponse, error)
	CreateProvider(context.Context, string, *pb.CreateProviderRequest) (*pb.ProviderResponse, error)
	UpdateProvider(context.Context, string, *pb.UpdateProviderRequest) (*pb.ProviderResponse, error)
	DeleteProvider(context.Context, string, string) error
	ListProviders(context.Context, string, *pb.ListProvidersRequest) (*pb.ListProvidersResponse, error)
	GetSandbox(context.Context, string, string) (*pb.SandboxResponse, error)
	AttachSandboxProvider(context.Context, string, *pb.AttachSandboxProviderRequest) (*pb.AttachSandboxProviderResponse, error)
	DetachSandboxProvider(context.Context, string, *pb.DetachSandboxProviderRequest) (*pb.DetachSandboxProviderResponse, error)
	ConfigureProviderRefresh(context.Context, string, *pb.ConfigureProviderRefreshRequest) (*pb.ConfigureProviderRefreshResponse, error)
	RotateProviderCredential(context.Context, string, *pb.RotateProviderCredentialRequest) (*pb.RotateProviderCredentialResponse, error)
}

type managedCredential struct {
	Credential types.Credential
	Token      string
}

type managedProvider struct {
	data      *datapb.Provider
	refresh   *pb.ConfigureProviderRefreshRequest
	env       map[string]string
	inference bool
	githubApp *managedGitHubApp
	profile   *pb.ProviderProfile
	payloads  []openshell.Payload
}

// ReconcileManagedProviders resolves injection grants and maintains providers in
// the session workspace. It never reads Kubernetes Secrets or returns secrets in
// the runner environment. The caller must stop active runtime access on failure.
func ReconcileManagedProviders(ctx context.Context, sdk *sdkclient.Client, gateway *openshell.GatewayClient, target string, session types.Session, agent *types.Agent) (*ManagedProviderPlan, error) {
	credentials, err := resolveManagedCredentials(ctx, sdk, session)
	if err != nil {
		return nil, fmt.Errorf("resolve managed credentials: %w", err)
	}
	if err := validateManagedProviderDeclarations(ctx, sdk, credentials, session, agent); err != nil {
		return nil, err
	}
	return reconcileManagedProviders(ctx, gateway, target, session, agent, credentials)
}

func normalizeManagedProvider(provider string) string {
	switch strings.ToLower(provider) {
	case "claude", "claude-code":
		return "anthropic"
	case "google-vertex-ai":
		return "vertex"
	default:
		return strings.ToLower(provider)
	}
}

func resolveManagedCredentials(ctx context.Context, sdk *sdkclient.Client, session types.Session) ([]managedCredential, error) {
	roles, err := sdk.Roles().List(ctx, &types.ListOptions{Size: 2, Search: "name = 'credential:viewer'"})
	if err != nil || len(roles.Items) != 1 || roles.Items[0].ID == "" {
		return nil, fmt.Errorf("credential injection role is unavailable")
	}
	roleID := roles.Items[0].ID
	it := sdk.RoleBindings().ListAll(ctx, &types.ListOptions{Size: 100, Search: "scope = 'credential'"})
	var bindings []types.RoleBinding
	for it.Next() {
		b := it.Item()
		if managedBindingTier(b, roleID, session) >= 0 {
			bindings = append(bindings, b)
		}
	}
	if err := it.Err(); err != nil {
		return nil, fmt.Errorf("credential bindings are unavailable")
	}
	sort.Slice(bindings, func(i, j int) bool {
		a, b := bindings[i], bindings[j]
		ta, tb := managedBindingTier(a, roleID, session), managedBindingTier(b, roleID, session)
		if ta != tb {
			return ta > tb
		}
		if a.CreatedAt != nil && b.CreatedAt != nil && !a.CreatedAt.Equal(*b.CreatedAt) {
			return a.CreatedAt.Before(*b.CreatedAt)
		}
		return a.ID < b.ID
	})
	selected := map[string]types.Credential{}
	cache := map[string]types.Credential{}
	for _, binding := range bindings {
		id := *binding.CredentialID
		credential, ok := cache[id]
		if !ok {
			c, err := sdk.Credentials().Get(ctx, id)
			if err != nil || c.ID != id || c.Provider == "" {
				return nil, fmt.Errorf("bound credential %s is unavailable", id)
			}
			credential = *c
			cache[id] = credential
		}
		provider := normalizeManagedProvider(credential.Provider)
		if _, exists := selected[provider]; !exists {
			selected[provider] = credential
		}
	}
	providers := make([]string, 0, len(selected))
	for provider := range selected {
		providers = append(providers, provider)
	}
	sort.Strings(providers)
	result := make([]managedCredential, 0, len(providers))
	for _, provider := range providers {
		credential := selected[provider]
		token, err := sdk.Credentials().GetToken(ctx, credential.ID)
		if err != nil || token.CredentialID != credential.ID || normalizeManagedProvider(token.Provider) != provider || strings.TrimSpace(token.Token) == "" {
			return nil, fmt.Errorf("token for bound credential %s is unavailable", credential.ID)
		}
		credential.Provider = provider
		result = append(result, managedCredential{Credential: credential, Token: token.Token})
	}
	return result, nil
}

func managedBindingTier(b types.RoleBinding, roleID string, session types.Session) int {
	value := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	if b.RoleID != roleID || b.Scope != "credential" || value(b.CredentialID) == "" || value(b.UserID) != "" || value(b.SessionID) != "" {
		return -1
	}
	project, agent := value(b.ProjectID), value(b.AgentID)
	if agent != "" {
		if project == session.ProjectID && agent == session.AgentID && project != "" {
			return 2
		}
		return -1
	}
	if project != "" {
		if project == session.ProjectID {
			return 1
		}
		return -1
	}
	return 0
}

func validateManagedProviderDeclarations(ctx context.Context, sdk *sdkclient.Client, credentials []managedCredential, session types.Session, agent *types.Agent) error {
	if agent == nil {
		return nil
	}
	if agent.ProjectID != session.ProjectID {
		return fmt.Errorf("agent does not belong to session project")
	}
	selected := map[string]string{}
	for _, credential := range credentials {
		selected[credential.Credential.Provider] = credential.Credential.ID
		selected[credential.Credential.ID] = credential.Credential.ID
	}
	for _, name := range agent.Providers {
		if _, ok := selected[normalizeManagedProvider(name)]; ok {
			continue
		}
		if err := validateTSLValue(name); err != nil {
			return fmt.Errorf("invalid managed provider declaration")
		}
		if err := validateTSLValue(session.ProjectID); err != nil {
			return fmt.Errorf("invalid project ID")
		}
		providers, err := sdk.Providers().List(ctx, &types.ListOptions{Size: 2, Search: fmt.Sprintf("project_id = '%s' and name = '%s'", session.ProjectID, name)})
		if err != nil || len(providers.Items) != 1 {
			return fmt.Errorf("provider %s requires an authorized credential binding", name)
		}
		declaration := providers.Items[0]
		credentialID := selected[normalizeManagedProvider(declaration.Type)]
		if declaration.ProjectID != session.ProjectID || credentialID == "" || (declaration.Secret != "" && declaration.Secret != credentialID) {
			return fmt.Errorf("provider %s must use a bound ACP credential ID; Kubernetes Secret references are not supported", name)
		}
	}
	return nil
}

func managedProviderName(sessionID, credentialID string) string {
	digest := sha256.Sum256([]byte(sessionID + "\x00" + credentialID))
	return "acp-" + hex.EncodeToString(digest[:16])
}

func reconcileManagedProviders(ctx context.Context, gateway managedProviderGateway, target string, session types.Session, agent *types.Agent, credentials []managedCredential) (*ManagedProviderPlan, error) {
	if session.ID == "" || session.ProjectID == "" || target == "" {
		return nil, fmt.Errorf("session scope is incomplete")
	}
	plan := &ManagedProviderPlan{Environment: map[string]string{}}
	desired := map[string]bool{}
	providers := make([]managedProvider, 0, len(credentials))
	for _, credential := range credentials {
		provider, err := buildManagedProvider(session, agent, credential)
		if err != nil {
			return nil, err
		}
		name := provider.data.Metadata.Name
		desired[name] = true
		providers = append(providers, provider)
		plan.Names = append(plan.Names, name)
		plan.Payloads = append(plan.Payloads, provider.payloads...)
		for key, value := range provider.env {
			plan.Environment[key] = value
		}
		if provider.inference {
			if plan.InferenceProvider != "" {
				return nil, fmt.Errorf("multiple inference credentials are bound; bind one inference provider for this agent")
			}
			plan.InferenceProvider = name
		}
	}
	var sandbox *pb.Sandbox
	if session.SandboxName != "" {
		response, err := gateway.GetSandbox(ctx, target, session.SandboxName)
		if err != nil && status.Code(err) != codes.NotFound {
			return nil, fmt.Errorf("read sandbox provider state: %s", status.Code(err))
		}
		if response != nil {
			sandbox = response.GetSandbox()
		}
	}
	// Revoke old attachments before updating or attaching replacement credentials.
	if sandbox != nil {
		for _, name := range sandbox.GetSpec().GetProviders() {
			if desired[name] {
				continue
			}
			response, err := gateway.DetachSandboxProvider(ctx, target, &pb.DetachSandboxProviderRequest{SandboxName: session.SandboxName, ProviderName: name, ExpectedResourceVersion: sandbox.GetMetadata().GetResourceVersion()})
			if err != nil {
				return nil, fmt.Errorf("%w: detach provider failed (%s)", ErrBindingsChanged, status.Code(err))
			}
			sandbox = response.GetSandbox()
			if sandbox == nil {
				return nil, fmt.Errorf("%w: detach returned no sandbox", ErrBindingsChanged)
			}
		}
	}
	var remove []string
	for offset := uint32(0); ; {
		response, err := gateway.ListProviders(ctx, target, &pb.ListProvidersRequest{Limit: 100, Offset: offset})
		if err != nil {
			return nil, fmt.Errorf("list workspace providers: %s", status.Code(err))
		}
		items := response.GetProviders()
		for _, provider := range items {
			meta := provider.GetMetadata()
			if meta.GetLabels()[managedProviderLabel] != "true" || meta.GetAnnotations()[managedSessionAnnotation] != session.ID || desired[meta.GetName()] {
				continue
			}
			remove = append(remove, meta.GetName())
		}
		if len(items) < 100 {
			break
		}
		offset += uint32(len(items))
	}
	for _, name := range remove {
		if err := gateway.DeleteProvider(ctx, target, name); err != nil && status.Code(err) != codes.NotFound {
			return nil, fmt.Errorf("%w: delete provider failed (%s)", ErrBindingsChanged, status.Code(err))
		}
	}
	for _, provider := range providers {
		name := provider.data.Metadata.Name
		existing, err := gateway.GetProvider(ctx, target, name)
		needsUpdate := true
		if err != nil && status.Code(err) != codes.NotFound {
			return nil, fmt.Errorf("get managed provider: %s", status.Code(err))
		}
		if err == nil {
			current := existing.GetProvider()
			if current == nil || current.GetMetadata().GetAnnotations()[managedSessionAnnotation] != session.ID || current.GetMetadata().GetAnnotations()[managedCredentialAnnotation] != provider.data.Metadata.Annotations[managedCredentialAnnotation] {
				return nil, fmt.Errorf("provider ownership does not match session")
			}
			provider.data.Metadata.Id = current.GetMetadata().GetId()
			provider.data.Metadata.ResourceVersion = current.GetMetadata().GetResourceVersion()
			sourceVersion := provider.data.Metadata.Annotations[managedSourceVersionAnnotation]
			runtimeInputsChanged := managedProviderState(current, managedRuntimeInputsConfig, managedRuntimeInputsAnnotation) != provider.data.Config[managedRuntimeInputsConfig] || current.GetType() != provider.data.Type
			if session.Phase == PhaseRunning && runtimeInputsChanged {
				return nil, fmt.Errorf("%w: restart the session to load changed credential settings", ErrBindingsChanged)
			}
			needsUpdate = sourceVersion == "" || managedProviderState(current, managedSourceVersionConfig, managedSourceVersionAnnotation) != sourceVersion || !maps.Equal(current.GetConfig(), provider.data.Config) || runtimeInputsChanged
		}
		if err := reconcileManagedProfile(ctx, gateway, target, provider.profile); err != nil {
			return nil, err
		}
		exists := err == nil
		if provider.githubApp != nil {
			if existing != nil && existing.GetProvider().GetCredentialExpiresAtMs()["GITHUB_TOKEN"] <= time.Now().Add(5*time.Minute).UnixMilli() {
				needsUpdate = true
			}
			if needsUpdate {
				token, expires, tokenErr := provider.githubApp.installationToken(ctx, managedProviderHTTPClient)
				if tokenErr != nil {
					return nil, tokenErr
				}
				provider.data.Credentials = map[string]string{"GITHUB_TOKEN": token}
				provider.data.CredentialExpiresAtMs = map[string]int64{"GITHUB_TOKEN": expires.UnixMilli()}
			}
		}
		if exists {
			if needsUpdate {
				// Native UpdateProvider merges maps. Empty values remove old keys.
				for key := range existing.GetProvider().GetConfig() {
					if _, keep := provider.data.Config[key]; !keep {
						provider.data.Config[key] = ""
					}
				}
				_, err = gateway.UpdateProvider(ctx, target, &pb.UpdateProviderRequest{Provider: provider.data, CredentialExpiresAtMs: provider.data.CredentialExpiresAtMs})
			}
		} else {
			_, err = gateway.CreateProvider(ctx, target, &pb.CreateProviderRequest{Provider: provider.data})
		}
		if err != nil {
			return nil, fmt.Errorf("write managed provider: %s", status.Code(err))
		}
		refreshDue := needsUpdate
		if provider.refresh != nil && existing != nil {
			expiry := existing.GetProvider().GetCredentialExpiresAtMs()[provider.refresh.CredentialKey]
			refreshDue = refreshDue || expiry <= time.Now().Add(5*time.Minute).UnixMilli()
		}
		if provider.refresh != nil && refreshDue {
			if _, err := gateway.ConfigureProviderRefresh(ctx, target, provider.refresh); err != nil {
				return nil, fmt.Errorf("configure provider refresh: %s", status.Code(err))
			}
			if _, err := gateway.RotateProviderCredential(ctx, target, &pb.RotateProviderCredentialRequest{Provider: name, CredentialKey: provider.refresh.CredentialKey}); err != nil {
				return nil, fmt.Errorf("rotate provider credential: %s", status.Code(err))
			}
		}
		if sandbox != nil {
			attached := false
			for _, n := range sandbox.GetSpec().GetProviders() {
				if n == name {
					attached = true
				}
			}
			if !attached {
				if session.Phase == PhaseRunning && (provider.data.Type == "google-cloud" || len(provider.env) > 0 || len(provider.payloads) > 0) {
					return nil, fmt.Errorf("%w: restart the session to load the new credential environment", ErrBindingsChanged)
				}
				response, err := gateway.AttachSandboxProvider(ctx, target, &pb.AttachSandboxProviderRequest{SandboxName: session.SandboxName, ProviderName: name, ExpectedResourceVersion: sandbox.GetMetadata().GetResourceVersion()})
				if err != nil {
					return nil, fmt.Errorf("attach managed provider: %s", status.Code(err))
				}
				sandbox = response.GetSandbox()
				if sandbox == nil {
					return nil, fmt.Errorf("attach returned no sandbox")
				}
			}
		}
	}
	sort.Strings(plan.Names)
	if plan.InferenceProvider != "" {
		plan.Environment["ACP_OPENSHELL_INFERENCE"] = "true"
	}
	return plan, nil
}

func managedProviderState(provider *datapb.Provider, configKey, legacyAnnotation string) string {
	if value, exists := provider.GetConfig()[configKey]; exists {
		return value
	}
	return provider.GetMetadata().GetAnnotations()[legacyAnnotation]
}

func rejectManagedProviderStateOverride(agent *types.Agent, credential managedCredential) error {
	if agent != nil {
		for key := range agent.Environment {
			if strings.HasPrefix(key, managedProviderStatePrefix) {
				return fmt.Errorf("agent environment cannot set reserved provider state")
			}
		}
	}
	var annotations map[string]json.RawMessage
	if json.Unmarshal([]byte(credential.Credential.Annotations), &annotations) == nil {
		for key := range annotations {
			if strings.HasPrefix(key, managedProviderStatePrefix) {
				return fmt.Errorf("credential annotations cannot set reserved provider state")
			}
		}
	}
	return nil
}

func buildManagedProvider(session types.Session, agent *types.Agent, credential managedCredential) (managedProvider, error) {
	if err := rejectManagedProviderStateOverride(agent, credential); err != nil {
		return managedProvider{}, err
	}
	kind := normalizeManagedProvider(credential.Credential.Provider)
	name := managedProviderName(session.ID, credential.Credential.ID)
	version := ""
	if credential.Credential.UpdatedAt != nil {
		version = credential.Credential.UpdatedAt.UTC().Format(time.RFC3339Nano)
	}
	result := managedProvider{data: &datapb.Provider{Metadata: &datapb.ObjectMeta{Name: name, Labels: map[string]string{managedProviderLabel: "true"}, Annotations: map[string]string{managedSessionAnnotation: session.ID, managedCredentialAnnotation: credential.Credential.ID, managedSourceVersionAnnotation: version}}, Type: openshell.OpenShellProviderType(kind), Config: map[string]string{}}, env: map[string]string{}, inference: openshell.IsInferenceCapable(kind)}
	switch kind {
	case "github":
		if strings.HasPrefix(strings.TrimSpace(credential.Token), "{") {
			app, err := parseManagedGitHubApp(credential.Token)
			if err != nil {
				return result, err
			}
			result.githubApp = app
			result.env["GITHUB_TOKEN"] = "openshell:resolve:env:GITHUB_TOKEN"
			result.env["GH_TOKEN"] = "openshell:resolve:env:GITHUB_TOKEN"
		} else {
			result.data.Credentials = openshell.ProviderCredentials(kind, credential.Token)
		}
	case "anthropic", "copilot", "deepinfra", "nvidia":
		if strings.HasPrefix(strings.TrimSpace(credential.Token), "{") {
			return result, fmt.Errorf("credential %s requires a supported token format; structured %s credentials are not supported", credential.Credential.ID, kind)
		}
		result.data.Credentials = openshell.ProviderCredentials(kind, credential.Token)
	case "mlflow":
		result.data.Credentials = map[string]string{"MLFLOW_TRACKING_TOKEN": credential.Token}
	case "jira":
		if credential.Credential.URL == "" || credential.Credential.Email == "" {
			return result, fmt.Errorf("invalid configuration: Jira credential requires URL and email")
		}
		result.data.Credentials = map[string]string{"JIRA_API_TOKEN": credential.Token}
		result.env["JIRA_URL"] = credential.Credential.URL
		result.env["JIRA_EMAIL"] = credential.Credential.Email
	case "codex":
		var token struct {
			Tokens map[string]string `json:"tokens"`
		}
		if json.Unmarshal([]byte(credential.Token), &token) != nil || token.Tokens["access_token"] == "" || token.Tokens["refresh_token"] == "" || token.Tokens["account_id"] == "" {
			return result, fmt.Errorf("invalid configuration: Codex credential requires auth JSON with access_token, refresh_token, and account_id")
		}
		result.data.Credentials = map[string]string{"CODEX_AUTH_ACCESS_TOKEN": token.Tokens["access_token"], "CODEX_AUTH_REFRESH_TOKEN": token.Tokens["refresh_token"], "CODEX_AUTH_ACCOUNT_ID": token.Tokens["account_id"], "CODEX_AUTH_ID_TOKEN": token.Tokens["id_token"]}
	case "vertex":
		if err := configureManagedVertex(&result, agent, credential); err != nil {
			return result, err
		}
	case "google":
		if err := configureManagedGoogleCloud(&result, credential); err != nil {
			return result, err
		}
	case "kubeconfig":
		if err := configureManagedKubeconfig(&result, session, credential); err != nil {
			return result, err
		}
	default:
		return result, fmt.Errorf("credential provider %s has no managed gateway profile", kind)
	}
	for key := range result.data.Credentials {
		// Inference credentials stay at the gateway. Other credentials are resolved
		// by OpenShell and are never included in ACP's environment payload.
		if !result.inference {
			result.env[key] = "openshell:resolve:env:" + key
		}
	}
	// Track the values that a runner loads at startup. Credential values and
	// refresh material are excluded so token rotation does not stop a session.
	runtimeInputs, err := json.Marshal(struct {
		Environment map[string]string   `json:"environment"`
		Payloads    []openshell.Payload `json:"payloads"`
		Config      map[string]string   `json:"config"`
		Profile     *pb.ProviderProfile `json:"profile"`
	}{result.env, result.payloads, result.data.Config, result.profile})
	if err != nil {
		return result, fmt.Errorf("encode managed credential settings: %w", err)
	}
	digest := sha256.Sum256(runtimeInputs)
	fingerprint := hex.EncodeToString(digest[:])
	result.data.Metadata.Annotations[managedRuntimeInputsAnnotation] = fingerprint
	for key := range result.data.Config {
		if strings.HasPrefix(key, managedProviderStatePrefix) {
			return result, fmt.Errorf("provider driver cannot set reserved provider state")
		}
	}
	// Add reconciliation state after hashing runtime inputs: source rotation must
	// not change the runner environment or require a session restart.
	result.data.Config[managedSourceVersionConfig] = version
	result.data.Config[managedRuntimeInputsConfig] = fingerprint
	return result, nil
}

func configureManagedVertex(provider *managedProvider, agent *types.Agent, credential managedCredential) error {
	var source struct {
		ProjectID string `json:"project_id"`
	}
	if json.Unmarshal([]byte(credential.Token), &source) != nil {
		return fmt.Errorf("invalid configuration: Vertex credential must contain Google credential JSON")
	}
	annotations := map[string]string{}
	if credential.Credential.Annotations != "" && json.Unmarshal([]byte(credential.Credential.Annotations), &annotations) != nil {
		return fmt.Errorf("invalid configuration: Vertex credential annotations must be a JSON string map")
	}
	project, region := annotations["vertex_project_id"], annotations["vertex_region"]
	if project == "" {
		project = source.ProjectID
	}
	if agent != nil {
		if p := agent.Environment["ANTHROPIC_VERTEX_PROJECT_ID"]; p != "" {
			project = p
		}
		if r := agent.Environment["CLOUD_ML_REGION"]; r != "" {
			region = r
		}
		// Keep the existing explicit gateway aliases as the final overrides.
		if p := agent.Environment["VERTEX_PROJECT_ID"]; p != "" {
			project = p
		}
		if r := agent.Environment["VERTEX_REGION"]; r != "" {
			region = r
		}
	}
	if project == "" || region == "" {
		return fmt.Errorf("invalid configuration: Vertex credential requires vertex_project_id and vertex_region annotations")
	}
	provider.data.Config = openshell.ProviderConfig("vertex", project, region)
	kind, err := openshell.DetectGoogleCredentialType(credential.Token)
	if err != nil {
		return fmt.Errorf("unsupported Google credential JSON")
	}
	provider.refresh = &pb.ConfigureProviderRefreshRequest{Provider: provider.data.Metadata.Name, CredentialKey: openshell.VertexRefreshCredentialKey(kind)}
	switch kind {
	case openshell.GoogleCredentialServiceAccount:
		material, err := openshell.ExtractServiceAccountJWTMaterial(credential.Token)
		if err != nil {
			return fmt.Errorf("invalid Google service account material")
		}
		provider.data.Credentials = map[string]string{"GOOGLE_SERVICE_ACCOUNT_KEY": credential.Token}
		provider.refresh.Strategy = pb.ProviderCredentialRefreshStrategy_PROVIDER_CREDENTIAL_REFRESH_STRATEGY_GOOGLE_SERVICE_ACCOUNT_JWT
		provider.refresh.Material = map[string]string{"client_email": material.ClientEmail, "private_key": material.PrivateKey}
		provider.refresh.SecretMaterialKeys = []string{"private_key"}
	case openshell.GoogleCredentialAuthorizedUser:
		material, err := openshell.ExtractOAuth2RefreshMaterial(credential.Token)
		if err != nil {
			return fmt.Errorf("invalid Google refresh material")
		}
		provider.data.Credentials = map[string]string{}
		provider.refresh.Strategy = pb.ProviderCredentialRefreshStrategy_PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_REFRESH_TOKEN
		provider.refresh.Material = map[string]string{"client_id": material.ClientID, "client_secret": material.ClientSecret, "refresh_token": material.RefreshToken, "client_email": material.Account, "private_key": "not-used-for-oauth2"}
		provider.refresh.SecretMaterialKeys = []string{"client_secret", "refresh_token", "private_key"}
	}
	return nil
}
