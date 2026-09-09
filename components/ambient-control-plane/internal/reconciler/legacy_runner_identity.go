package reconciler

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/runnerauth"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/tokenserver"
	sdkclient "github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/client"
	"github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/types"
)

// LegacyRunnerIdentity keeps the Kubernetes backend on the same scoped runner
// authentication contract as the managed backend.
type LegacyRunnerIdentity struct {
	factory *SDKClientFactory
	key     *rsa.PrivateKey
}

func NewLegacyRunnerIdentity(factory *SDKClientFactory, key *rsa.PrivateKey) *LegacyRunnerIdentity {
	return &LegacyRunnerIdentity{factory: factory, key: key}
}

func (i *LegacyRunnerIdentity) Prepare(ctx context.Context, sdk *sdkclient.Client, session types.Session, sandboxName, namespace string) (types.Session, string, error) {
	if i == nil || i.key == nil {
		return session, "", fmt.Errorf("runner signing identity is not configured")
	}
	current, err := sdk.Sessions().Get(ctx, session.ID)
	if err != nil {
		return session, "", fmt.Errorf("read runner identity state: %w", err)
	}
	if current.ProjectID != session.ProjectID || (current.RuntimeBackend != "" && current.RuntimeBackend != "kubernetes") {
		return session, "", fmt.Errorf("session runtime does not match Kubernetes backend")
	}
	if current.Phase != PhasePending && current.Phase != "" && current.Phase != PhaseCreating {
		return session, "", fmt.Errorf("session is not ready to start")
	}
	if current.RunnerGeneration == "" || current.Phase != PhaseCreating {
		generation := make([]byte, 24)
		if _, err := rand.Read(generation); err != nil {
			return session, "", fmt.Errorf("create runner generation: %w", err)
		}
		current, err = sdk.Runtime().PatchSession(ctx, current.ID, current.RuntimeVersion, map[string]interface{}{"runtime_backend": "kubernetes", "sandbox_name": sandboxName, "runner_generation": hex.EncodeToString(generation), "kube_namespace": namespace, "phase": PhaseCreating, "expected_phase": current.Phase})
		if err != nil {
			return session, "", fmt.Errorf("save runner identity: %w", err)
		}
	}
	if current.SandboxName != sandboxName || current.KubeNamespace != namespace {
		return session, "", fmt.Errorf("runner sandbox mapping changed")
	}
	ttl := runnerauth.MaxBootstrapTTL
	if current.Timeout > 0 && time.Duration(current.Timeout)*time.Second < ttl {
		ttl = time.Duration(current.Timeout) * time.Second
	}
	token, err := tokenserver.IssueBootstrap(i.key, current.ID, current.ProjectID, current.SandboxName, current.RunnerGeneration, ttl)
	if err != nil {
		return session, "", fmt.Errorf("issue runner capability: %w", err)
	}
	return *current, token, nil
}
func (i *LegacyRunnerIdentity) ValidateRunner(ctx context.Context, claims runnerauth.Claims) error {
	sdk, err := i.factory.ForProject(ctx, claims.ProjectID)
	if err != nil {
		return err
	}
	s, err := sdk.Sessions().Get(ctx, claims.SessionID)
	if err != nil {
		return fmt.Errorf("session is not available")
	}
	if s.RuntimeBackend != "kubernetes" || s.ProjectID != claims.ProjectID || s.SandboxName != claims.SandboxName || s.RunnerGeneration != claims.Generation || (s.Phase != PhaseCreating && s.Phase != PhaseRunning) {
		return fmt.Errorf("runner identity is no longer active")
	}
	return nil
}
func (i *LegacyRunnerIdentity) AuthorizeSandbox(ctx context.Context, bearer, sessionID, sandboxName string) (string, error) {
	sdk, err := sdkclient.NewServiceClient(i.factory.BaseURL(), bearer)
	if err != nil {
		return "", err
	}
	s, err := sdk.Sessions().Get(ctx, sessionID)
	if err != nil {
		return "", fmt.Errorf("session access denied")
	}
	if s.RuntimeBackend != "kubernetes" || s.SandboxName != sandboxName || s.KubeNamespace == "" {
		return "", fmt.Errorf("sandbox does not match session")
	}
	return s.KubeNamespace, nil
}

func (r *SimpleKubeReconciler) applyLegacyRunnerEnvironment(env map[string]string, session types.Session, bootstrap string) {
	delete(env, "AMBIENT_TOKEN")
	delete(env, "AMBIENT_API_TOKEN")
	delete(env, "AMBIENT_CP_TOKEN_PUBLIC_KEY")
	env["SESSION_ID"] = session.ID
	env["AMBIENT_PROJECT_ID"] = session.ProjectID
	env["AMBIENT_RUNNER_BOOTSTRAP_TOKEN"] = bootstrap
	env["AMBIENT_CP_TOKEN_URL"] = r.cfg.CPTokenURL
	env["AMBIENT_GRPC_URL"] = r.cfg.RunnerGRPCURL
	env["AMBIENT_GRPC_USE_TLS"] = boolToStr(r.cfg.RunnerGRPCUseTLS)
	env["AMBIENT_GRPC_CA_CERT_FILE"] = legacyRunnerCAPath
	env["AMBIENT_CP_CA_CERT_FILE"] = legacyRunnerCAPath
	env["AMBIENT_ALLOW_INSECURE_RUNNER_TRANSPORT"] = boolToStr(r.cfg.AllowInsecureRunnerTransport)
}

const legacyRunnerCAPath = "/sandbox/.config/acp/runner-ca.pem"

func (r *SimpleKubeReconciler) legacyRunnerPayloads(payloads []types.Payload) ([]types.Payload, error) {
	if r.cfg.AllowInsecureRunnerTransport && !r.cfg.RunnerGRPCUseTLS && !strings.HasPrefix(r.cfg.CPTokenURL, "https://") {
		return payloads, nil
	}
	var bundle []byte
	for _, path := range []string{r.cfg.CACertFile, "/var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt"} {
		if path == "" {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, fmt.Errorf("read runner trust bundle: %w", err)
		}
		for len(data) > 0 {
			block, rest := pem.Decode(data)
			if block == nil {
				break
			}
			data = rest
			if block.Type != "CERTIFICATE" {
				continue
			}
			if _, err := x509.ParseCertificate(block.Bytes); err != nil {
				return nil, fmt.Errorf("runner trust file contains an invalid certificate")
			}
			bundle = append(bundle, pem.EncodeToMemory(block)...)
		}
	}
	if !x509.NewCertPool().AppendCertsFromPEM(bundle) {
		return nil, fmt.Errorf("runner TLS requires a valid CA_CERT_FILE or service CA bundle")
	}
	return append(payloads, types.Payload{SandboxPath: legacyRunnerCAPath, Content: string(bundle)}), nil
}
