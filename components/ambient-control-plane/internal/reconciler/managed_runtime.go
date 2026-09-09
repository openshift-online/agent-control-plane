package reconciler

import (
	"context"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/auth"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/config"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/hypershell"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/runnerauth"
	sdkclient "github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/client"
	"github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/types"
	"github.com/rs/zerolog"
)

const ManagedBackend = "hypershell"

type gatewayCredential struct {
	GatewayID  string                `json:"gateway_id"`
	AccountID  string                `json:"account_id"`
	Connection hypershell.Connection `json:"connection"`
}

type managedTokenCache struct {
	fingerprint [32]byte
	provider    auth.TokenProvider
}

// ManagedReconciler uses API inventory for recovery. It never reads or changes
// gateway namespaces, pods, Secrets, or sandbox custom resources.
type ManagedReconciler struct {
	factory    *SDKClientFactory
	hs         *hypershell.Client
	gateway    *openshell.GatewayClient
	cfg        *config.HypershellConfig
	runnerCfg  KubeReconcilerConfig
	privateKey *rsa.PrivateKey
	logger     zerolog.Logger
	tlsConfig  *tls.Config
	caPEM      []byte
	mu         sync.RWMutex
	projects   map[string]types.Project
	sessions   map[string]types.Session
	tokens     map[string]managedTokenCache
	wake       chan struct{}
}

func NewManagedReconciler(factory *SDKClientFactory, hs *hypershell.Client, cfg *config.HypershellConfig, runnerCfg KubeReconcilerConfig, key *rsa.PrivateKey, logger zerolog.Logger) (*ManagedReconciler, error) {
	pool, err := x509.SystemCertPool()
	if err != nil {
		return nil, fmt.Errorf("load system trust: %w", err)
	}
	var ca []byte
	if cfg.CACertFile != "" {
		ca, err = os.ReadFile(cfg.CACertFile)
		if err != nil {
			return nil, fmt.Errorf("read managed CA bundle: %w", err)
		}
		if !pool.AppendCertsFromPEM(ca) {
			return nil, fmt.Errorf("managed CA bundle has no certificates")
		}
	}
	return &ManagedReconciler{factory: factory, hs: hs, cfg: cfg, runnerCfg: runnerCfg, privateKey: key, logger: logger.With().Str("component", "hypershell-runtime").Logger(), tlsConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool}, caPEM: ca, projects: make(map[string]types.Project), sessions: make(map[string]types.Session), tokens: make(map[string]managedTokenCache), wake: make(chan struct{}, 1)}, nil
}

func (r *ManagedReconciler) SetGateway(g *openshell.GatewayClient) { r.gateway = g }

func (r *ManagedReconciler) sdk(ctx context.Context) (*sdkclient.Client, error) {
	token, err := r.factory.Token(ctx)
	if err != nil {
		return nil, err
	}
	return sdkclient.NewServiceClient(r.factory.BaseURL(), token)
}

func (r *ManagedReconciler) ResolveTarget(ctx context.Context, key string) (openshell.GatewayTarget, error) {
	gatewayID, workspace, err := openshell.ParseTargetKey(key)
	if err != nil {
		return openshell.GatewayTarget{}, err
	}
	r.mu.RLock()
	var project types.Project
	for _, p := range r.projects {
		if p.GatewayID == gatewayID {
			project = p
			break
		}
	}
	r.mu.RUnlock()
	if project.GatewayID == "" || project.GatewayCredentialID == "" || project.GatewayEndpoint == "" {
		return openshell.GatewayTarget{}, fmt.Errorf("gateway binding is not ready")
	}
	sdk, err := r.sdk(ctx)
	if err != nil {
		return openshell.GatewayTarget{}, err
	}
	credential, err := sdk.Credentials().GetToken(ctx, project.GatewayCredentialID)
	if err != nil {
		return openshell.GatewayTarget{}, fmt.Errorf("read gateway credential: %w", err)
	}
	var binding gatewayCredential
	if err := json.Unmarshal([]byte(credential.Token), &binding); err != nil {
		return openshell.GatewayTarget{}, fmt.Errorf("stored gateway credential is invalid")
	}
	if binding.GatewayID != gatewayID || binding.AccountID != project.GatewayAccountID {
		return openshell.GatewayTarget{}, fmt.Errorf("gateway credential does not match binding")
	}
	u, err := url.Parse(binding.Connection.TokenEndpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return openshell.GatewayTarget{}, fmt.Errorf("gateway token endpoint must use HTTPS")
	}
	if binding.Connection.ClientID == "" || binding.Connection.ClientSecret == "" {
		return openshell.GatewayTarget{}, fmt.Errorf("gateway credential is incomplete")
	}
	fingerprint := sha256.Sum256([]byte(credential.Token))
	r.mu.Lock()
	cached, ok := r.tokens[project.GatewayCredentialID]
	if !ok || cached.fingerprint != fingerprint {
		cached = managedTokenCache{fingerprint: fingerprint, provider: auth.NewOIDCTokenProvider(binding.Connection.TokenEndpoint, binding.Connection.ClientID, binding.Connection.ClientSecret, r.logger)}
		r.tokens[project.GatewayCredentialID] = cached
	}
	r.mu.Unlock()
	return openshell.GatewayTarget{Endpoint: project.GatewayEndpoint, Workspace: workspace, TLSConfig: r.tlsConfig.Clone(), TokenProvider: cached.provider, Revision: project.GatewayCredentialID + ":" + hex.EncodeToString(fingerprint[:])}, nil
}

func (r *ManagedReconciler) ValidateRunner(ctx context.Context, claims runnerauth.Claims) error {
	sdk, err := r.sdk(ctx)
	if err != nil {
		return err
	}
	s, err := sdk.Sessions().Get(ctx, claims.SessionID)
	if err != nil {
		return fmt.Errorf("session is not available")
	}
	if s.RuntimeBackend != ManagedBackend || s.ProjectID != claims.ProjectID || s.SandboxName != claims.SandboxName || s.RunnerGeneration != claims.Generation || (s.Phase != PhaseCreating && s.Phase != PhaseRunning) {
		return fmt.Errorf("runner identity is no longer active")
	}
	return nil
}

func (r *ManagedReconciler) AuthorizeSandbox(ctx context.Context, bearer, sessionID, sandboxName string) (string, error) {
	sdk, err := sdkclient.NewServiceClient(r.factory.BaseURL(), bearer)
	if err != nil {
		return "", err
	}
	s, err := sdk.Sessions().Get(ctx, sessionID)
	if err != nil {
		return "", fmt.Errorf("session access denied")
	}
	if s.RuntimeBackend != ManagedBackend || s.SandboxName != sandboxName || s.GatewayID == "" || s.GatewayWorkspace == "" {
		return "", fmt.Errorf("sandbox does not match session")
	}
	return openshell.TargetKey(s.GatewayID, s.GatewayWorkspace), nil
}

// Notify coalesces watch events. Inventory remains the recovery source after gaps.
func (r *ManagedReconciler) Notify() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

func (r *ManagedReconciler) Run(ctx context.Context) error {
	if r.gateway == nil {
		return fmt.Errorf("managed gateway client is required")
	}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		if err := r.sweep(ctx); err != nil && ctx.Err() == nil {
			r.logger.Error().Err(err).Msg("runtime reconciliation failed; retrying")
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		case <-r.wake:
		}
	}
}

func (r *ManagedReconciler) sweep(ctx context.Context) error {
	sdk, err := r.sdk(ctx)
	if err != nil {
		return err
	}
	projects := make(map[string]types.Project)
	sessions := make(map[string]types.Session)
	for page := 1; ; page++ {
		list, err := sdk.Runtime().Projects(ctx, page, 100)
		if err != nil {
			return fmt.Errorf("project inventory: %w", err)
		}
		for _, p := range list.Items {
			projects[p.ID] = p
		}
		if page*100 >= list.Total {
			break
		}
	}
	for page := 1; ; page++ {
		list, err := sdk.Runtime().Sessions(ctx, page, 100)
		if err != nil {
			return fmt.Errorf("session inventory: %w", err)
		}
		for _, s := range list.Items {
			sessions[s.ID] = s
		}
		if page*100 >= list.Total {
			break
		}
	}
	r.mu.Lock()
	r.projects = projects
	r.sessions = sessions
	r.mu.Unlock()
	var failures []error
	for _, p := range projects {
		if p.RuntimeDeleted {
			continue
		}
		if p.RuntimeBackend != "" && p.RuntimeBackend != ManagedBackend {
			continue
		}
		opCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		err := r.reconcileProject(opCtx, sdk, p)
		cancel()
		if err != nil {
			failures = append(failures, fmt.Errorf("workspace %s: %w", p.ID, err))
			r.mu.RLock()
			current := r.projects[p.ID]
			r.mu.RUnlock()
			if current.GatewayError == "" {
				_, patchErr := r.patchProject(ctx, sdk, current, map[string]interface{}{"gateway_error": "Gateway reconciliation failed. Contact your workspace administrator."})
				if patchErr != nil {
					failures = append(failures, patchErr)
				}
			}
		}
	}
	for _, s := range sessions {
		if s.RuntimeBackend != "" && s.RuntimeBackend != ManagedBackend {
			continue
		}
		p, ok := projects[s.ProjectID]
		if !ok {
			failures = append(failures, fmt.Errorf("session %s has no workspace record", s.ID))
			continue
		}
		opCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		err := r.reconcileManagedSession(opCtx, sdk, p, s)
		cancel()
		if err != nil {
			failures = append(failures, fmt.Errorf("session %s: %w", s.ID, err))
			r.mu.RLock()
			current := r.sessions[s.ID]
			r.mu.RUnlock()
			if current.RuntimeError == "" {
				_, patchErr := r.patchSession(ctx, sdk, current, map[string]interface{}{"runtime_error": "Sandbox reconciliation failed. Contact your workspace administrator."})
				if patchErr != nil {
					failures = append(failures, patchErr)
				}
			}
		}
	}
	for _, p := range projects {
		if p.RuntimeDeleted && p.RuntimeBackend == ManagedBackend {
			opCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
			err := r.deleteManagedProject(opCtx, sdk, p, sessions)
			cancel()
			if err != nil {
				failures = append(failures, fmt.Errorf("delete workspace %s: %w", p.ID, err))
			}
		}
	}
	return errors.Join(failures...)
}

func runtimeNotFound(err error) bool {
	var apiErr *types.APIError
	return errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusNotFound
}

func stableRuntimeName(prefix, value string) string {
	sum := sha256.Sum256([]byte(value))
	return prefix + hex.EncodeToString(sum[:16])
}

func (r *ManagedReconciler) patchProject(ctx context.Context, sdk *sdkclient.Client, p types.Project, fields map[string]interface{}) (*types.Project, error) {
	updated, err := sdk.Runtime().PatchProject(ctx, p.ID, p.RuntimeVersion, fields)
	if err == nil {
		r.mu.Lock()
		r.projects[p.ID] = *updated
		r.mu.Unlock()
	}
	return updated, err
}

func (r *ManagedReconciler) patchSession(ctx context.Context, sdk *sdkclient.Client, s types.Session, fields map[string]interface{}) (*types.Session, error) {
	updated, err := sdk.Runtime().PatchSession(ctx, s.ID, s.RuntimeVersion, fields)
	if err == nil {
		r.mu.Lock()
		r.sessions[s.ID] = *updated
		r.mu.Unlock()
	}
	return updated, err
}

func (r *ManagedReconciler) reconcileProject(ctx context.Context, sdk *sdkclient.Client, p types.Project) error {
	if p.GatewayInstanceID != "" && p.GatewayInstanceID != r.cfg.InstanceID {
		return fmt.Errorf("workspace belongs to another Hypershell instance")
	}
	if p.GatewayExternalReference == "" {
		incarnation := ""
		if p.CreatedAt != nil {
			incarnation = p.CreatedAt.UTC().Format(time.RFC3339Nano)
		}
		_, err := r.patchProject(ctx, sdk, p, map[string]interface{}{"runtime_backend": ManagedBackend, "gateway_instance_id": r.cfg.InstanceID, "gateway_external_reference": r.cfg.InstanceID + "/" + stableRuntimeName("workspace-", p.ID+"/"+incarnation), "gateway_status": "Provisioning", "gateway_error": ""})
		return err
	}
	var gw *hypershell.Gateway
	var err error
	if p.GatewayID == "" {
		gw, err = r.hs.CreateGateway(ctx, "acp-"+p.Name, p.GatewayExternalReference, r.cfg.GatewayTemplate)
	} else {
		gw, err = r.hs.GetGateway(ctx, p.GatewayID)
	}
	if err != nil {
		return err
	}
	if gw.ID == "" || gw.ExternalReference != p.GatewayExternalReference {
		return fmt.Errorf("Hypershell gateway does not match the workspace reference")
	}
	if p.GatewayID == "" {
		_, err = r.patchProject(ctx, sdk, p, map[string]interface{}{"gateway_id": gw.ID, "gateway_status": "Provisioning"})
		return err
	}
	if gw.Phase != "Running" || gw.Status != "Healthy" || gw.RouteAddress == "" {
		state := gw.Phase
		if state == "" {
			state = "Provisioning"
		}
		if p.GatewayStatus != state {
			_, err = r.patchProject(ctx, sdk, p, map[string]interface{}{"gateway_status": state, "gateway_error": ""})
		}
		return err
	}
	if p.GatewayEndpoint != gw.RouteAddress {
		_, err = r.patchProject(ctx, sdk, p, map[string]interface{}{"gateway_endpoint": gw.RouteAddress})
		return err
	}
	return r.ensureGatewayCredential(ctx, sdk, p)
}

func (r *ManagedReconciler) ensureGatewayCredential(ctx context.Context, sdk *sdkclient.Client, p types.Project) error {
	accountName := stableRuntimeName("acp-", p.GatewayExternalReference)
	accounts, err := r.hs.ListAccounts(ctx, p.GatewayID)
	if err != nil {
		return err
	}
	// Remove accounts whose one-time secret could not be committed after a crash.
	for _, account := range accounts {
		if account.Name != accountName || account.ID == p.GatewayAccountID {
			continue
		}
		if account.Status != "revoked" && account.Status != "expired" {
			done, err := r.hs.RevokeAccount(ctx, p.GatewayID, account.ID)
			if err != nil {
				return err
			}
			if !done {
				return fmt.Errorf("orphan gateway credential revocation is pending")
			}
		}
		if err := r.deleteOrphanGatewayCredentials(ctx, sdk, p.GatewayID, account.ID); err != nil {
			return err
		}
	}
	if p.GatewayAccountID != "" {
		account, err := r.hs.GetAccount(ctx, p.GatewayID, p.GatewayAccountID)
		if err != nil && !hypershell.IsNotFound(err) {
			return err
		}
		valid := err == nil && account.Status == "ready" && time.Until(account.ExpiresAt) > 24*time.Hour
		if valid && p.GatewayCredentialID != "" {
			if _, err := sdk.Credentials().GetToken(ctx, p.GatewayCredentialID); err == nil {
				if p.GatewayStatus != "Ready" || p.GatewayError != "" {
					_, err = r.patchProject(ctx, sdk, p, map[string]interface{}{"gateway_status": "Ready", "gateway_error": ""})
					return err
				}
				return nil
			} else if !runtimeNotFound(err) {
				return err
			}
		}
		if !hypershell.IsNotFound(err) {
			done, err := r.hs.RevokeAccount(ctx, p.GatewayID, p.GatewayAccountID)
			if err != nil {
				return err
			}
			if !done {
				return fmt.Errorf("gateway credential rotation is pending")
			}
		}
		if p.GatewayCredentialID != "" {
			if err := sdk.Credentials().Delete(ctx, p.GatewayCredentialID); err != nil && !runtimeNotFound(err) {
				return err
			}
		}
		_, err = r.patchProject(ctx, sdk, p, map[string]interface{}{"gateway_account_id": "", "gateway_credential_id": "", "gateway_status": "Provisioning"})
		return err
	}
	account, err := r.hs.CreateAccount(ctx, p.GatewayID, accountName)
	if err != nil {
		return err
	}
	binding := gatewayCredential{GatewayID: p.GatewayID, AccountID: account.ID, Connection: account.Credential}
	encoded, err := json.Marshal(binding)
	if err != nil {
		return fmt.Errorf("encode gateway credential")
	}
	credential, err := sdk.Credentials().Create(ctx, &types.Credential{Name: stableRuntimeName("hypershell-", p.GatewayID+"/"+account.ID), Provider: "openshell-gateway", Token: string(encoded)})
	if err != nil {
		_, revokeErr := r.hs.RevokeAccount(ctx, p.GatewayID, account.ID)
		return errors.Join(fmt.Errorf("save gateway credential: %w", err), revokeErr)
	}
	_, err = r.patchProject(ctx, sdk, p, map[string]interface{}{"gateway_account_id": account.ID, "gateway_account_expires_at": account.ExpiresAt.UTC().Format(time.RFC3339), "gateway_credential_id": credential.ID, "gateway_status": "Ready", "gateway_error": ""})
	if err != nil {
		_, revokeErr := r.hs.RevokeAccount(ctx, p.GatewayID, account.ID)
		deleteErr := sdk.Credentials().Delete(ctx, credential.ID)
		return errors.Join(err, revokeErr, deleteErr)
	}
	return nil
}

// A lost credential-create response can leave an encrypted credential without
// a binding. Its name is derived from the gateway and one-time account ID.
func (r *ManagedReconciler) deleteOrphanGatewayCredentials(ctx context.Context, sdk *sdkclient.Client, gatewayID, accountID string) error {
	name := stableRuntimeName("hypershell-", gatewayID+"/"+accountID)
	items := sdk.Credentials().ListAll(ctx, &types.ListOptions{Size: 100, Search: "name = '" + name + "' and provider = 'openshell-gateway'"})
	for items.Next() {
		credential := items.Item()
		if credential.Name != name || credential.Provider != "openshell-gateway" {
			return fmt.Errorf("orphan credential search returned an unrelated record")
		}
		if err := sdk.Credentials().Delete(ctx, credential.ID); err != nil && !runtimeNotFound(err) {
			return err
		}
	}
	return items.Err()
}

func (r *ManagedReconciler) deleteManagedProject(ctx context.Context, sdk *sdkclient.Client, p types.Project, sessions map[string]types.Session) error {
	if p.GatewayInstanceID != "" && p.GatewayInstanceID != r.cfg.InstanceID {
		return fmt.Errorf("workspace belongs to another Hypershell instance")
	}
	if p.GatewayStatus == "Deleted" {
		return nil
	}
	if p.GatewayID == "" && p.GatewayExternalReference != "" {
		deletion, err := r.hs.GatewayDeletion(ctx, p.GatewayExternalReference)
		if err == nil {
			if deletion.GatewayID == "" || deletion.ExternalReference != p.GatewayExternalReference {
				return fmt.Errorf("gateway deletion does not match workspace")
			}
			_, err = r.patchProject(ctx, sdk, p, map[string]interface{}{"gateway_id": deletion.GatewayID, "gateway_status": "DeletionRequested"})
			return err
		}
		if !hypershell.IsNotFound(err) {
			return err
		}
		// Replay the durable create key even during deletion. A timed-out create
		// may still be in flight; a list miss cannot prove that no resource exists.
		gateway, err := r.hs.CreateGateway(ctx, "acp-"+p.Name, p.GatewayExternalReference, r.cfg.GatewayTemplate)
		if err != nil {
			return err
		}
		if gateway.ID == "" || gateway.ExternalReference != p.GatewayExternalReference {
			return fmt.Errorf("recovered gateway does not match workspace")
		}
		_, err = r.patchProject(ctx, sdk, p, map[string]interface{}{"gateway_id": gateway.ID, "gateway_status": "Deleting"})
		return err
	}
	if p.GatewayStatus == "DeletionRequested" {
		status, err := r.hs.GatewayDeletion(ctx, p.GatewayExternalReference)
		if err != nil {
			return err
		}
		if status.GatewayID != p.GatewayID || status.ExternalReference != p.GatewayExternalReference {
			return fmt.Errorf("gateway deletion does not match workspace")
		}
		if status.State != "completed" || status.DeletionCompletedAt == nil {
			return nil
		}
		_, err = r.patchProject(ctx, sdk, p, map[string]interface{}{"gateway_status": "Deleted", "gateway_error": ""})
		return err
	}
	for _, s := range sessions {
		if s.ProjectID == p.ID && s.RuntimeStatus != "Deleted" && s.GatewayID != "" {
			return nil
		}
	}
	if p.GatewayID != "" {
		accounts, err := r.hs.ListAccounts(ctx, p.GatewayID)
		if err != nil && !hypershell.IsNotFound(err) {
			return err
		}
		accountName := stableRuntimeName("acp-", p.GatewayExternalReference)
		for _, account := range accounts {
			if account.Name != accountName {
				continue
			}
			if account.Status != "revoked" && account.Status != "expired" {
				done, err := r.hs.RevokeAccount(ctx, p.GatewayID, account.ID)
				if err != nil {
					return err
				}
				if !done {
					return fmt.Errorf("gateway credential revocation is pending")
				}
			}
			if err := r.deleteOrphanGatewayCredentials(ctx, sdk, p.GatewayID, account.ID); err != nil {
				return err
			}
		}
	}
	if p.GatewayAccountID != "" {
		done, err := r.hs.RevokeAccount(ctx, p.GatewayID, p.GatewayAccountID)
		if err != nil {
			return err
		}
		if !done {
			return fmt.Errorf("gateway credential revocation is pending")
		}
	}
	if p.GatewayCredentialID != "" {
		if err := sdk.Credentials().Delete(ctx, p.GatewayCredentialID); err != nil && !runtimeNotFound(err) {
			return err
		}
	}
	state := "Deleted"
	if p.GatewayID != "" {
		if err := r.hs.DeleteGateway(ctx, p.GatewayID); err != nil {
			return err
		}
		state = "DeletionRequested"
	}
	_, err := r.patchProject(ctx, sdk, p, map[string]interface{}{"gateway_status": state, "gateway_credential_id": "", "gateway_error": ""})
	return err
}
