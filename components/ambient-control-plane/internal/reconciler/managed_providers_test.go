package reconciler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	datapb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/datamodel/v1"
	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	sdkclient "github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/client"
	"github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/types"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

// Fixed values used only by these tests.
const (
	testProviderValue            = "test-credential-value"
	testReplacementProviderValue = "replacement-test-value"
	testRotatedProviderValue     = "rotated-token"
)

func managedString(s string) *string { return &s }

func TestManagedBindingRequiresInjectionIntent(t *testing.T) {
	session := types.Session{ProjectID: "project-a", AgentID: "agent-a"}
	base := types.RoleBinding{RoleID: "viewer-role", Scope: "credential", CredentialID: managedString("credential-a")}
	for _, tc := range []struct {
		name   string
		change func(*types.RoleBinding)
		tier   int
	}{
		{"global", func(b *types.RoleBinding) {}, 0},
		{"project", func(b *types.RoleBinding) { b.ProjectID = managedString("project-a") }, 1},
		{"agent", func(b *types.RoleBinding) {
			b.ProjectID = managedString("project-a")
			b.AgentID = managedString("agent-a")
		}, 2},
		{"owner", func(b *types.RoleBinding) { b.RoleID = "owner-role" }, -1},
		{"token reader", func(b *types.RoleBinding) { b.RoleID = "token-reader-role" }, -1},
		{"human viewer", func(b *types.RoleBinding) { b.UserID = managedString("alice") }, -1},
		{"runtime grant", func(b *types.RoleBinding) { b.SessionID = managedString("session-b") }, -1},
		{"other project", func(b *types.RoleBinding) { b.ProjectID = managedString("project-b") }, -1},
		{"other agent", func(b *types.RoleBinding) {
			b.ProjectID = managedString("project-a")
			b.AgentID = managedString("agent-b")
		}, -1},
		{"agent no project", func(b *types.RoleBinding) { b.AgentID = managedString("agent-a") }, -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := base
			tc.change(&b)
			if got := managedBindingTier(b, "viewer-role", session); got != tc.tier {
				t.Fatalf("tier %d, want %d", got, tc.tier)
			}
		})
	}
}

func TestManagedCredentialResolutionRetainsSelectedID(t *testing.T) {
	var fetched []string
	bindings := []types.RoleBinding{
		{RoleID: "viewer-role", Scope: "credential", CredentialID: managedString("global")},
		{RoleID: "viewer-role", Scope: "credential", CredentialID: managedString("project"), ProjectID: managedString("project-a")},
		{RoleID: "viewer-role", Scope: "credential", CredentialID: managedString("agent"), ProjectID: managedString("project-a"), AgentID: managedString("agent-a")},
		{RoleID: "owner-role", Scope: "credential", CredentialID: managedString("owner-only")},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/roles"):
			if err := json.NewEncoder(w).Encode(map[string]interface{}{"items": []map[string]string{{"id": "viewer-role", "name": "credential:viewer"}}, "total": 1}); err != nil {
				t.Errorf("write API test response: %v", err)
			}
		case strings.HasSuffix(r.URL.Path, "/role_bindings"):
			items := bindings
			if r.URL.Query().Get("page") != "1" {
				items = nil
			}
			if err := json.NewEncoder(w).Encode(map[string]interface{}{"items": items, "total": len(bindings), "page": 1, "size": 100}); err != nil {
				t.Errorf("write API test response: %v", err)
			}
		case strings.HasSuffix(r.URL.Path, "/token"):
			parts := strings.Split(r.URL.Path, "/")
			id := parts[len(parts)-2]
			fetched = append(fetched, id)
			if err := json.NewEncoder(w).Encode(types.CredentialTokenResponse{CredentialID: id, Provider: "github", Token: testProviderValue}); err != nil {
				t.Errorf("write API test response: %v", err)
			}
		default:
			parts := strings.Split(r.URL.Path, "/")
			id := parts[len(parts)-1]
			if id == "owner-only" {
				t.Error("ownership credential read")
			}
			if err := json.NewEncoder(w).Encode(map[string]string{"id": id, "name": id, "provider": "github"}); err != nil {
				t.Errorf("write API test response: %v", err)
			}
		}
	}))
	defer server.Close()
	sdk, err := sdkclient.NewClient(server.URL, "test-service-token-value", "project-a")
	if err != nil {
		t.Fatal(err)
	}
	result, err := resolveManagedCredentials(context.Background(), sdk, types.Session{ProjectID: "project-a", AgentID: "agent-a"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != 1 || result[0].Credential.ID != "agent" || !reflect.DeepEqual(fetched, []string{"agent"}) {
		t.Fatalf("wrong selection: %+v / %v", result, fetched)
	}
}

type managedFakeGateway struct {
	profiles     map[string]*pb.ProviderProfile
	providers    map[string]*datapb.Provider
	sandbox      *pb.Sandbox
	detachError  error
	refreshError error
	operations   []string
	target       string
}

func (g *managedFakeGateway) scope(target string) {
	if g.target == "" {
		g.target = target
	}
	if target != g.target {
		panic("test gateway target changed")
	}
}
func (g *managedFakeGateway) GetProvider(ctx context.Context, target, name string) (*pb.ProviderResponse, error) {
	g.scope(target)
	p := g.providers[name]
	if p == nil {
		return nil, status.Error(codes.NotFound, "missing")
	}
	return &pb.ProviderResponse{Provider: proto.Clone(p).(*datapb.Provider)}, nil
}
func (g *managedFakeGateway) CreateProvider(ctx context.Context, target string, r *pb.CreateProviderRequest) (*pb.ProviderResponse, error) {
	g.scope(target)
	name := r.Provider.Metadata.Name
	g.providers[name] = proto.Clone(r.Provider).(*datapb.Provider)
	if g.providers[name].Credentials == nil {
		g.providers[name].Credentials = map[string]string{}
	}
	g.operations = append(g.operations, "create:"+name)
	return &pb.ProviderResponse{Provider: g.providers[name]}, nil
}
func (g *managedFakeGateway) UpdateProvider(ctx context.Context, target string, r *pb.UpdateProviderRequest) (*pb.ProviderResponse, error) {
	g.scope(target)
	current := g.providers[r.Provider.Metadata.Name]
	if current == nil {
		return nil, status.Error(codes.NotFound, "missing")
	}
	if r.Provider.Metadata.ResourceVersion != current.Metadata.ResourceVersion {
		return nil, status.Error(codes.Aborted, "stale")
	}
	if current.Config == nil {
		current.Config = map[string]string{}
	}
	if current.Credentials == nil {
		current.Credentials = map[string]string{}
	}
	if current.CredentialExpiresAtMs == nil {
		current.CredentialExpiresAtMs = map[string]int64{}
	}
	for key, value := range r.CredentialExpiresAtMs {
		if value == 0 {
			delete(current.CredentialExpiresAtMs, key)
		} else {
			current.CredentialExpiresAtMs[key] = value
		}
	}
	// Match pinned OpenShell: metadata is immutable; maps merge, and empty
	// values remove keys. A replacement fake hid the live rotation failure.
	for _, pair := range []struct{ current, update map[string]string }{
		{current.Config, r.Provider.Config}, {current.Credentials, r.Provider.Credentials},
	} {
		for key, value := range pair.update {
			if value == "" {
				delete(pair.current, key)
			} else {
				pair.current[key] = value
			}
		}
	}
	current.Metadata.ResourceVersion++
	g.operations = append(g.operations, "update:"+r.Provider.Metadata.Name)
	return &pb.ProviderResponse{Provider: proto.Clone(current).(*datapb.Provider)}, nil
}
func (g *managedFakeGateway) DeleteProvider(ctx context.Context, target, name string) error {
	g.scope(target)
	delete(g.providers, name)
	g.operations = append(g.operations, "delete:"+name)
	return nil
}
func (g *managedFakeGateway) ListProviders(ctx context.Context, target string, r *pb.ListProvidersRequest) (*pb.ListProvidersResponse, error) {
	g.scope(target)
	names := make([]string, 0, len(g.providers))
	for name := range g.providers {
		names = append(names, name)
	}
	sort.Strings(names)
	var providers []*datapb.Provider
	for i := int(r.Offset); i < len(names) && i < int(r.Offset+r.Limit); i++ {
		providers = append(providers, g.providers[names[i]])
	}
	return &pb.ListProvidersResponse{Providers: providers}, nil
}
func (g *managedFakeGateway) GetSandbox(ctx context.Context, target, name string) (*pb.SandboxResponse, error) {
	g.scope(target)
	if g.sandbox == nil {
		return nil, status.Error(codes.NotFound, "missing")
	}
	return &pb.SandboxResponse{Sandbox: g.sandbox}, nil
}
func (g *managedFakeGateway) AttachSandboxProvider(ctx context.Context, target string, r *pb.AttachSandboxProviderRequest) (*pb.AttachSandboxProviderResponse, error) {
	g.scope(target)
	if r.ExpectedResourceVersion != g.sandbox.Metadata.ResourceVersion {
		return nil, status.Error(codes.Aborted, "stale")
	}
	g.sandbox.Spec.Providers = append(g.sandbox.Spec.Providers, r.ProviderName)
	g.sandbox.Metadata.ResourceVersion++
	g.operations = append(g.operations, "attach:"+r.ProviderName)
	return &pb.AttachSandboxProviderResponse{Sandbox: g.sandbox}, nil
}
func (g *managedFakeGateway) DetachSandboxProvider(ctx context.Context, target string, r *pb.DetachSandboxProviderRequest) (*pb.DetachSandboxProviderResponse, error) {
	g.scope(target)
	if g.detachError != nil {
		return nil, g.detachError
	}
	if r.ExpectedResourceVersion != g.sandbox.Metadata.ResourceVersion {
		return nil, status.Error(codes.Aborted, "stale")
	}
	var names []string
	for _, name := range g.sandbox.Spec.Providers {
		if name != r.ProviderName {
			names = append(names, name)
		}
	}
	g.sandbox.Spec.Providers = names
	g.sandbox.Metadata.ResourceVersion++
	g.operations = append(g.operations, "detach:"+r.ProviderName)
	return &pb.DetachSandboxProviderResponse{Sandbox: g.sandbox}, nil
}
func (g *managedFakeGateway) ConfigureProviderRefresh(ctx context.Context, target string, r *pb.ConfigureProviderRefreshRequest) (*pb.ConfigureProviderRefreshResponse, error) {
	g.scope(target)
	g.operations = append(g.operations, "refresh:"+r.Provider)
	return &pb.ConfigureProviderRefreshResponse{}, g.refreshError
}
func (g *managedFakeGateway) RotateProviderCredential(ctx context.Context, target string, r *pb.RotateProviderCredentialRequest) (*pb.RotateProviderCredentialResponse, error) {
	g.scope(target)
	g.operations = append(g.operations, "rotate:"+r.Provider)
	provider := g.providers[r.Provider]
	if provider.CredentialExpiresAtMs == nil {
		provider.CredentialExpiresAtMs = map[string]int64{}
	}
	provider.CredentialExpiresAtMs[r.CredentialKey] = time.Now().Add(time.Hour).UnixMilli()
	return &pb.RotateProviderCredentialResponse{}, nil
}

func managedTestSession() types.Session {
	return types.Session{ObjectReference: types.ObjectReference{ID: "session-a"}, ProjectID: "project-a", SandboxName: "sandbox-a"}
}
func managedTestCredential(provider string) managedCredential {
	return managedCredential{Credential: types.Credential{ObjectReference: types.ObjectReference{ID: "credential-a"}, Provider: provider}, Token: testProviderValue}
}

func TestManagedProviderRotationAndRevocation(t *testing.T) {
	session := managedTestSession()
	credential := managedTestCredential("github")
	gateway := &managedFakeGateway{providers: map[string]*datapb.Provider{}, sandbox: &pb.Sandbox{Metadata: &datapb.ObjectMeta{Name: session.SandboxName, ResourceVersion: 1}, Spec: &pb.SandboxSpec{}}}
	plan, err := reconcileManagedProviders(context.Background(), gateway, "gateway-a/session-a", session, nil, []managedCredential{credential})
	if err != nil {
		t.Fatal(err)
	}
	name := plan.Names[0]
	if gateway.providers[name].Credentials["GITHUB_TOKEN"] != credential.Token {
		t.Fatal("selected token not stored in gateway")
	}
	for _, value := range plan.Environment {
		if value == credential.Token {
			t.Fatal("secret leaked into sandbox environment")
		}
	}
	credential.Token = testReplacementProviderValue
	if _, err := reconcileManagedProviders(context.Background(), gateway, gateway.target, session, nil, []managedCredential{credential}); err != nil {
		t.Fatal(err)
	}
	if gateway.providers[name].Credentials["GITHUB_TOKEN"] != credential.Token {
		t.Fatal("rotation not propagated")
	}
	gateway.operations = nil
	if _, err := reconcileManagedProviders(context.Background(), gateway, gateway.target, session, nil, nil); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gateway.operations, []string{"detach:" + name, "delete:" + name}) {
		t.Fatalf("unsafe revocation order: %v", gateway.operations)
	}
	if len(gateway.sandbox.Spec.Providers) != 0 || len(gateway.providers) != 0 {
		t.Fatal("revoked credential retained")
	}
}

func TestManagedProviderDetachFailureRequiresStop(t *testing.T) {
	session := managedTestSession()
	gateway := &managedFakeGateway{providers: map[string]*datapb.Provider{}, sandbox: &pb.Sandbox{Metadata: &datapb.ObjectMeta{Name: session.SandboxName, ResourceVersion: 1}, Spec: &pb.SandboxSpec{Providers: []string{"old-provider"}}}, detachError: status.Error(codes.PermissionDenied, "test")}
	if _, err := reconcileManagedProviders(context.Background(), gateway, "gateway-a/session-a", session, nil, nil); !errors.Is(err, ErrBindingsChanged) {
		t.Fatalf("revocation failure was hidden: %v", err)
	}
}

func TestManagedProviderNamesIsolateSessionsAndCredentials(t *testing.T) {
	if managedProviderName("session-a", "cred-a") == managedProviderName("session-b", "cred-a") || managedProviderName("session-a", "cred-a") == managedProviderName("session-a", "cred-b") {
		t.Fatal("provider names collide")
	}
}

func TestManagedStructuredCredentialProfiles(t *testing.T) {
	session := managedTestSession()
	for _, kind := range []string{"kubeconfig", "google", "unknown"} {
		if _, err := buildManagedProvider(session, nil, managedTestCredential(kind)); err == nil {
			t.Fatalf("unsupported %s profile silently accepted", kind)
		}
	}
	codex := managedTestCredential("codex")
	codex.Token = `{"tokens":{"access_token":"access","refresh_token":"refresh","account_id":"account","id_token":"id"}}`
	built, err := buildManagedProvider(session, nil, codex)
	if err != nil {
		t.Fatal(err)
	}
	if built.data.Credentials["CODEX_AUTH_ACCOUNT_ID"] != "account" {
		t.Fatal("codex auth JSON was not mapped")
	}
	jira := managedTestCredential("jira")
	jira.Credential.URL = "https://jira.example"
	jira.Credential.Email = "user@example.com"
	if _, err := buildManagedProvider(session, nil, jira); err != nil {
		t.Fatal(err)
	}
	vertex := managedTestCredential("vertex")
	vertex.Token = `{"type":"authorized_user","client_id":"client","client_secret":"secret","refresh_token":"refresh","account":"user@example.com"}`
	vertex.Credential.Annotations = `{"vertex_project_id":"project-a","vertex_region":"us-east5"}`
	built, err = buildManagedProvider(session, nil, vertex)
	if err != nil {
		t.Fatal(err)
	}
	if built.refresh == nil || built.refresh.Strategy != pb.ProviderCredentialRefreshStrategy_PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_REFRESH_TOKEN {
		t.Fatal("Google refresh not configured")
	}
	if len(built.data.Credentials) != 0 {
		t.Fatal("raw Google refresh material put into provider credentials")
	}
}

func TestManagedFailedRefreshIsRetried(t *testing.T) {
	session := managedTestSession()
	credential := managedTestCredential("vertex")
	now := time.Now()
	credential.Credential.UpdatedAt = &now
	credential.Token = `{"type":"authorized_user","client_id":"client","client_secret":"secret","refresh_token":"refresh","account":"user@example.com"}`
	credential.Credential.Annotations = `{"vertex_project_id":"project-a","vertex_region":"us-east5"}`
	gateway := &managedFakeGateway{providers: map[string]*datapb.Provider{}, refreshError: status.Error(codes.Unavailable, "test")}
	if _, err := reconcileManagedProviders(context.Background(), gateway, "gateway-a/session-a", session, nil, []managedCredential{credential}); err == nil {
		t.Fatal("failed refresh ignored")
	}
	gateway.refreshError = nil
	gateway.operations = nil
	if _, err := reconcileManagedProviders(context.Background(), gateway, gateway.target, session, nil, []managedCredential{credential}); err != nil {
		t.Fatal(err)
	}
	if len(gateway.operations) != 2 || !strings.HasPrefix(gateway.operations[0], "refresh:") || !strings.HasPrefix(gateway.operations[1], "rotate:") {
		t.Fatalf("refresh not retried: %v", gateway.operations)
	}
}

func TestManagedVertexEnvironmentAliases(t *testing.T) {
	credential := managedTestCredential("vertex")
	credential.Token = `{"type":"authorized_user","client_id":"client","client_secret":"secret","refresh_token":"refresh","account":"user@example.com"}`
	credential.Credential.Annotations = `{"vertex_project_id":"annotation-project","vertex_region":"us-east5"}`
	for _, tc := range []struct {
		name        string
		environment map[string]string
		project     string
		region      string
	}{
		{name: "standard runner names", environment: map[string]string{"ANTHROPIC_VERTEX_PROJECT_ID": "runner-project", "CLOUD_ML_REGION": "global"}, project: "runner-project", region: "global"},
		{name: "gateway aliases retain precedence", environment: map[string]string{"ANTHROPIC_VERTEX_PROJECT_ID": "runner-project", "CLOUD_ML_REGION": "global", "VERTEX_PROJECT_ID": "gateway-project", "VERTEX_REGION": "us-central1"}, project: "gateway-project", region: "us-central1"},
		{name: "annotations remain fallback", environment: map[string]string{"ANTHROPIC_VERTEX_PROJECT_ID": "", "CLOUD_ML_REGION": ""}, project: "annotation-project", region: "us-east5"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			built, err := buildManagedProvider(managedTestSession(), &types.Agent{Environment: tc.environment}, credential)
			if err != nil {
				t.Fatal(err)
			}
			if built.data.Config["VERTEX_AI_PROJECT_ID"] != tc.project || built.data.Config["VERTEX_AI_REGION"] != tc.region {
				t.Fatalf("unexpected Vertex route configuration: %v", built.data.Config)
			}
			if built.refresh == nil || built.refresh.Strategy != pb.ProviderCredentialRefreshStrategy_PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_REFRESH_TOKEN {
				t.Fatal("ADC refresh must remain configured")
			}
		})
	}
}

func TestManagedProviderSettingsRequireRestart(t *testing.T) {
	session := managedTestSession()
	credential := managedTestCredential("jira")
	credential.Credential.URL = "https://jira.example"
	credential.Credential.Email = "old@example.com"
	gateway := &managedFakeGateway{providers: map[string]*datapb.Provider{}, sandbox: &pb.Sandbox{Metadata: &datapb.ObjectMeta{Name: session.SandboxName, ResourceVersion: 1}, Spec: &pb.SandboxSpec{}}}
	plan, err := reconcileManagedProviders(context.Background(), gateway, "gateway-a/session-a", session, nil, []managedCredential{credential})
	if err != nil {
		t.Fatal(err)
	}
	name := plan.Names[0]
	session.Phase = PhaseRunning
	credential.Token = testRotatedProviderValue
	if _, err := reconcileManagedProviders(context.Background(), gateway, gateway.target, session, nil, []managedCredential{credential}); err != nil {
		t.Fatalf("secret-only rotation must not stop the runner: %v", err)
	}
	if gateway.providers[name].Credentials["JIRA_API_TOKEN"] != credential.Token {
		t.Fatal("token rotation was not applied")
	}
	before := proto.Clone(gateway.providers[name])
	gateway.operations = nil
	credential.Credential.Email = "new@example.com"
	if _, err := reconcileManagedProviders(context.Background(), gateway, gateway.target, session, nil, []managedCredential{credential}); !errors.Is(err, ErrBindingsChanged) {
		t.Fatalf("changed runner environment must require a restart: %v", err)
	}
	if len(gateway.operations) != 0 || !proto.Equal(before, gateway.providers[name]) {
		t.Fatal("gateway settings changed before runtime access stopped")
	}
	session.Phase = PhaseCreating
	plan, err = reconcileManagedProviders(context.Background(), gateway, gateway.target, session, nil, []managedCredential{credential})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Environment["JIRA_EMAIL"] != "new@example.com" {
		t.Fatal("restart did not load changed settings")
	}
}

func TestManagedProviderRotationConvergesWithImmutableMetadata(t *testing.T) {
	session := managedTestSession()
	credential := managedTestCredential("vertex")
	created := time.Now().Add(-time.Hour)
	credential.Credential.UpdatedAt = &created
	credential.Token = `{"type":"authorized_user","client_id":"client","client_secret":"secret","refresh_token":"refresh","account":"user@example.com"}`
	credential.Credential.Annotations = `{"vertex_project_id":"project-a","vertex_region":"global"}`
	gateway := &managedFakeGateway{providers: map[string]*datapb.Provider{}}
	plan, err := reconcileManagedProviders(context.Background(), gateway, "gateway-a/session-a", session, nil, []managedCredential{credential})
	if err != nil {
		t.Fatal(err)
	}
	name := plan.Names[0]
	before := proto.Clone(gateway.providers[name]).(*datapb.Provider)
	// Existing deployed providers have only immutable annotations. Migration must
	// update state once without treating the new keys as runner config changes.
	delete(gateway.providers[name].Config, managedSourceVersionConfig)
	delete(gateway.providers[name].Config, managedRuntimeInputsConfig)
	gateway.providers[name].Config["OLD_DRIVER_SETTING"] = "obsolete"
	session.Phase = PhaseRunning
	rotated := created.Add(time.Minute)
	credential.Credential.UpdatedAt = &rotated
	credential.Token = strings.Replace(credential.Token, `"refresh_token":"refresh"`, `"refresh_token":"replacement"`, 1)
	gateway.operations = nil
	if _, err := reconcileManagedProviders(context.Background(), gateway, gateway.target, session, nil, []managedCredential{credential}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gateway.operations, []string{"update:" + name, "refresh:" + name, "rotate:" + name}) {
		t.Fatalf("rotation operations: %v", gateway.operations)
	}
	current := gateway.providers[name]
	if current.Metadata.Annotations[managedSourceVersionAnnotation] != before.Metadata.Annotations[managedSourceVersionAnnotation] {
		t.Fatal("test server changed immutable metadata")
	}
	if current.Config[managedSourceVersionConfig] != rotated.UTC().Format(time.RFC3339Nano) {
		t.Fatal("mutable source version did not converge")
	}
	if current.Config[managedRuntimeInputsConfig] != before.Config[managedRuntimeInputsConfig] {
		t.Fatal("source rotation changed runner fingerprint")
	}
	if _, exists := current.Config["OLD_DRIVER_SETTING"]; exists {
		t.Fatal("native map merge retained obsolete config")
	}
	gateway.operations = nil
	for range 2 {
		if _, err := reconcileManagedProviders(context.Background(), gateway, gateway.target, session, nil, []managedCredential{credential}); err != nil {
			t.Fatal(err)
		}
	}
	if len(gateway.operations) != 0 {
		t.Fatalf("settled provider kept updating: %v", gateway.operations)
	}
}

func TestManagedProviderStateCannotBeOverridden(t *testing.T) {
	for _, key := range []string{managedSourceVersionConfig, managedRuntimeInputsConfig, managedProviderStatePrefix + "future"} {
		t.Run(key, func(t *testing.T) {
			credential := managedTestCredential("github")
			agent := &types.Agent{Environment: map[string]string{key: "forged"}}
			if _, err := buildManagedProvider(managedTestSession(), agent, credential); err == nil {
				t.Fatal("agent state override accepted")
			}
			annotations, err := json.Marshal(map[string]string{key: "forged"})
			if err != nil {
				t.Fatal(err)
			}
			credential.Credential.Annotations = string(annotations)
			if _, err := buildManagedProvider(managedTestSession(), nil, credential); err == nil {
				t.Fatal("credential state override accepted")
			}
		})
	}
}

func TestManagedProviderFingerprintUsesOnlyDriverInputs(t *testing.T) {
	credential := managedTestCredential("github")
	first := time.Now().Add(-time.Minute)
	credential.Credential.UpdatedAt = &first
	a, err := buildManagedProvider(managedTestSession(), nil, credential)
	if err != nil {
		t.Fatal(err)
	}
	second := first.Add(time.Second)
	credential.Credential.UpdatedAt = &second
	credential.Token = testReplacementProviderValue
	b, err := buildManagedProvider(managedTestSession(), nil, credential)
	if err != nil {
		t.Fatal(err)
	}
	if a.data.Config[managedSourceVersionConfig] == b.data.Config[managedSourceVersionConfig] {
		t.Fatal("test did not change source version")
	}
	if a.data.Config[managedRuntimeInputsConfig] != b.data.Config[managedRuntimeInputsConfig] {
		t.Fatal("mutable state entered runtime fingerprint")
	}
	if !reflect.DeepEqual(a.env, b.env) {
		t.Fatal("state or credentials entered runner environment")
	}
}
