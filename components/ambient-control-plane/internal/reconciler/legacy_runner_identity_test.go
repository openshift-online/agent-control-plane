package reconciler

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/auth"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/runnerauth"
	sdkclient "github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/client"
	"github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/types"
	"github.com/rs/zerolog"
)

func TestLegacyRunnerIdentityPersistsAndRevokesGeneration(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	current := types.Session{ObjectReference: types.ObjectReference{ID: "session-a"}, ProjectID: "project-a", Phase: PhasePending, RuntimeVersion: 2, Timeout: 300}
	var forwarded string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/runtime/sessions/") {
			var patch map[string]interface{}
			if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
				t.Error(err)
				return
			}
			if patch["runtime_version"] != float64(current.RuntimeVersion) || patch["expected_phase"] != current.Phase {
				w.WriteHeader(http.StatusConflict)
				return
			}
			current.RuntimeBackend = patch["runtime_backend"].(string)
			current.SandboxName = patch["sandbox_name"].(string)
			current.RunnerGeneration = patch["runner_generation"].(string)
			current.KubeNamespace = patch["kube_namespace"].(string)
			current.Phase = patch["phase"].(string)
			current.RuntimeVersion++
		} else {
			forwarded = r.Header.Get("Authorization")
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(current)
	}))
	defer server.Close()
	factory := NewSDKClientFactory(server.URL, auth.NewStaticTokenProvider("service-token-for-testing-only"), zerolog.Nop())
	identity := NewLegacyRunnerIdentity(factory, key)
	sdk, err := sdkclient.NewServiceClient(server.URL, "service-token-for-testing-only")
	if err != nil {
		t.Fatal(err)
	}
	prepared, bootstrap, err := identity.Prepare(context.Background(), sdk, current, "sandbox-a", "namespace-a")
	if err != nil {
		t.Fatal(err)
	}
	claims, err := runnerauth.Verify(&key.PublicKey, bootstrap, "bootstrap", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if claims.Generation == "" || claims.Generation != prepared.RunnerGeneration || claims.ExpiresAt-claims.IssuedAt != 300 {
		t.Fatal("wrong persisted capability")
	}
	if err := identity.ValidateRunner(context.Background(), claims); err != nil {
		t.Fatal(err)
	}
	target, err := identity.AuthorizeSandbox(context.Background(), "user-token-for-testing-only", current.ID, "sandbox-a")
	if err != nil || target != "namespace-a" || forwarded != "Bearer user-token-for-testing-only" {
		t.Fatal("user authorization not forwarded")
	}
	if _, err := identity.AuthorizeSandbox(context.Background(), "user-token-for-testing-only", current.ID, "other-sandbox"); err == nil {
		t.Fatal("cross-sandbox access allowed")
	}
	stale := claims
	stale.Generation = "old-generation"
	if err := identity.ValidateRunner(context.Background(), stale); err == nil {
		t.Fatal("old generation allowed")
	}
	current.Phase = PhaseStopped
	if err := identity.ValidateRunner(context.Background(), claims); err == nil {
		t.Fatal("stopped session allowed")
	}
	current.Phase = PhasePending
	_, newBootstrap, err := identity.Prepare(context.Background(), sdk, current, "sandbox-a", "namespace-a")
	if err != nil {
		t.Fatal(err)
	}
	next, err := runnerauth.Verify(&key.PublicKey, newBootstrap, "bootstrap", time.Now())
	if err != nil || next.Generation == claims.Generation {
		t.Fatal("restart reused generation")
	}
	if err := identity.ValidateRunner(context.Background(), claims); err == nil {
		t.Fatal("previous run capability accepted")
	}
}
func TestLegacyRunnerProtectedEnvironment(t *testing.T) {
	r := &SimpleKubeReconciler{cfg: KubeReconcilerConfig{CPTokenURL: "https://cp/token", RunnerGRPCURL: "api:9000", RunnerGRPCUseTLS: true}}
	env := map[string]string{"AMBIENT_TOKEN": "broad", "AMBIENT_API_TOKEN": "broad", "AMBIENT_RUNNER_BOOTSTRAP_TOKEN": "agent-value", "AMBIENT_ALLOW_INSECURE_RUNNER_TRANSPORT": "true"}
	r.applyLegacyRunnerEnvironment(env, types.Session{ObjectReference: types.ObjectReference{ID: "session"}, ProjectID: "project"}, "scoped")
	if env["AMBIENT_TOKEN"] != "" || env["AMBIENT_API_TOKEN"] != "" || env["AMBIENT_RUNNER_BOOTSTRAP_TOKEN"] != "scoped" || env["AMBIENT_ALLOW_INSECURE_RUNNER_TRANSPORT"] != "false" {
		t.Fatal("agent environment changed runner authentication")
	}
	if _, _, err := (*LegacyRunnerIdentity)(nil).Prepare(context.Background(), nil, types.Session{}, "", ""); err == nil {
		t.Fatal("missing issuer accepted")
	}
}
