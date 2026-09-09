package reconciler

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"time"

	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell"
	inferencepb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/inference/v1"
	sandboxpb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/sandbox/v1"
	openshellpb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/tokenserver"
	sdkclient "github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/client"
	"github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/types"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/structpb"
)

//go:embed managed_runner.py
var managedRunnerScript string

const managedRunnerPath = "/sandbox/workspace/.acp-runtime/launcher.py"
const managedPython = "/sandbox/.venv/bin/python"
const managedCAPath = "/sandbox/workspace/.acp-runtime/ca.pem"

func (r *ManagedReconciler) reconcileManagedSession(ctx context.Context, sdk *sdkclient.Client, p types.Project, s types.Session) error {
	if s.RuntimeStatus == "Deleted" {
		return nil
	}
	if s.RuntimeDeleted || p.RuntimeDeleted {
		return r.deleteManagedSession(ctx, sdk, s)
	}
	if s.GatewayID == "" {
		if s.Phase != "" && s.Phase != PhasePending {
			return nil
		}
		if p.GatewayStatus != "Ready" {
			if s.RuntimeStatus != "WaitingForGateway" {
				_, err := r.patchSession(ctx, sdk, s, map[string]interface{}{"runtime_backend": ManagedBackend, "runtime_status": "WaitingForGateway"})
				return err
			}
			return nil
		}
		_, err := r.patchSession(ctx, sdk, s, map[string]interface{}{"runtime_backend": ManagedBackend, "gateway_id": p.GatewayID, "gateway_workspace": stableRuntimeName("session-", s.ID), "sandbox_name": stableRuntimeName("acp-", s.ID), "gateway_endpoint": p.GatewayEndpoint, "gateway_credential_id": p.GatewayCredentialID, "runtime_status": "Pending"})
		return err
	}
	if s.GatewayID != p.GatewayID {
		return fmt.Errorf("session gateway no longer matches its workspace")
	}
	if p.GatewayStatus != "Ready" {
		return nil
	}
	if s.GatewayEndpoint != p.GatewayEndpoint || s.GatewayCredentialID != p.GatewayCredentialID {
		_, err := r.patchSession(ctx, sdk, s, map[string]interface{}{"gateway_endpoint": p.GatewayEndpoint, "gateway_credential_id": p.GatewayCredentialID})
		return err
	}
	target := openshell.TargetKey(s.GatewayID, s.GatewayWorkspace)
	if s.Phase == PhaseStopping || s.Phase == PhaseCompleted || s.Phase == PhaseFailed {
		return r.stopManagedSession(ctx, sdk, s, target)
	}
	if s.Phase == PhaseStopped {
		return nil
	}
	if s.Phase == PhasePending || s.Phase == "" {
		generation := make([]byte, 16)
		if _, err := rand.Read(generation); err != nil {
			return fmt.Errorf("generate runner identity: %w", err)
		}
		_, err := r.patchSession(ctx, sdk, s, map[string]interface{}{"runner_generation": hex.EncodeToString(generation), "phase": PhaseCreating, "expected_phase": s.Phase, "runtime_status": "Creating", "runtime_error": "", "completion_time": nil})
		return err
	}
	if s.Phase != PhaseCreating && s.Phase != PhaseRunning {
		return nil
	}
	readinessTimeout := time.Duration(r.runnerCfg.SandboxReadinessTimeoutSeconds) * time.Second
	if readinessTimeout <= 0 {
		readinessTimeout = 10 * time.Minute
	}
	if s.Phase == PhaseCreating && s.UpdatedAt != nil && time.Since(*s.UpdatedAt) > readinessTimeout {
		_, err := r.patchSession(ctx, sdk, s, map[string]interface{}{"phase": PhaseFailed, "expected_phase": s.Phase, "runtime_error": "Sandbox readiness timed out.", "runtime_status": "Stopping"})
		return err
	}
	if s.RunnerGeneration == "" {
		return fmt.Errorf("session has no runner generation")
	}
	projectSDK, err := r.factory.ForProject(ctx, s.ProjectID)
	if err != nil {
		return err
	}
	var agent *types.Agent
	if s.AgentID != "" {
		agent, err = projectSDK.Agents().Get(ctx, s.AgentID)
		if err != nil {
			return fmt.Errorf("get session agent: %w", err)
		}
	}
	if err := r.gateway.EnsureWorkspace(ctx, target, s.GatewayWorkspace); err != nil {
		return err
	}
	if _, err := r.gateway.UpdateConfig(ctx, target, &openshellpb.UpdateConfigRequest{Global: true, SettingKey: "providers_v2_enabled", SettingValue: &sandboxpb.SettingValue{Value: &sandboxpb.SettingValue_BoolValue{BoolValue: true}}}); err != nil {
		return fmt.Errorf("enable credential providers: %w", err)
	}
	plan, err := ReconcileManagedProviders(ctx, projectSDK, r.gateway, target, s, agent)
	if err != nil {
		// Invalidate the runner identity before requesting a stop. The next
		// inventory pass retries the stop if the gateway is unavailable.
		if s.Phase == PhaseRunning {
			_, patchErr := r.patchSession(ctx, sdk, s, map[string]interface{}{"phase": PhaseFailed, "expected_phase": s.Phase, "runner_generation": "", "runtime_status": "Stopping", "runtime_error": "Credential access could not be reconciled. Restart the session after the credential is fixed."})
			if patchErr != nil {
				return fmt.Errorf("record credential access failure: %w", patchErr)
			}
		}
		return err
	}
	if plan.InferenceProvider != "" {
		model := s.LlmModel
		if model == "" && agent != nil {
			model = agent.LlmModel
		}
		if model == "" {
			return fmt.Errorf("session model is required for managed inference")
		}
		if _, err := r.gateway.SetInferenceRoute(ctx, target, &inferencepb.SetInferenceRouteRequest{Workspace: s.GatewayWorkspace, ProviderName: plan.InferenceProvider, ModelId: model}); err != nil {
			return fmt.Errorf("set session inference route: %w", err)
		}
	}
	sandbox, err := r.gateway.GetSandbox(ctx, target, s.SandboxName)
	if status.Code(err) == codes.NotFound {
		if s.Phase == PhaseRunning {
			return fmt.Errorf("running sandbox is missing; explicit session restart is required")
		}
		helper := &SimpleKubeReconciler{factory: r.factory, cfg: r.runnerCfg, logger: r.logger}
		policy, err := helper.resolveAgentSandboxPolicy(ctx, projectSDK, s.ProjectID, agent)
		if err != nil {
			return err
		}
		if policy != nil {
			if policy.NetworkPolicies == nil {
				policy.NetworkPolicies = map[string]*sandboxpb.NetworkPolicyRule{}
			}
			rule, err := r.managedNetworkRule()
			if err != nil {
				return err
			}
			policy.NetworkPolicies[acpInternalPolicyKey] = rule
		}
		driver, err := structpb.NewStruct(r.cfg.SandboxDriverConfig)
		if err != nil {
			return fmt.Errorf("sandbox driver configuration: %w", err)
		}
		image := helper.resolveSandboxImage(agent)
		if image == "" {
			return fmt.Errorf("managed runner image is required")
		}
		sandbox, err = r.gateway.CreateSandbox(ctx, target, &openshellpb.CreateSandboxRequest{Name: s.SandboxName, Workspace: s.GatewayWorkspace, Labels: map[string]string{LabelManaged: "true", LabelManagedBy: "ambient-control-plane", LabelProjectID: s.ProjectID, "ambient-code.io/session-id": s.ID}, Spec: &openshellpb.SandboxSpec{Template: &openshellpb.SandboxTemplate{Image: image, DriverConfig: driver}, Environment: r.managedEnvironment(s, agent, plan), Providers: plan.Names, Policy: policy}})
	}
	if err != nil {
		return err
	}
	if sandbox == nil || sandbox.Sandbox == nil || sandbox.Sandbox.Metadata == nil {
		return fmt.Errorf("gateway returned an incomplete sandbox")
	}
	id := sandbox.Sandbox.Metadata.Id
	if sandbox.Sandbox.Metadata.Labels["ambient-code.io/session-id"] != s.ID || sandbox.Sandbox.Metadata.Labels[LabelProjectID] != s.ProjectID {
		return fmt.Errorf("sandbox ownership labels do not match session")
	}
	if id != s.SandboxID {
		_, err := r.patchSession(ctx, sdk, s, map[string]interface{}{"sandbox_id": id})
		return err
	}
	phase := sandbox.Sandbox.GetStatus().GetPhase()
	if phase == openshellpb.SandboxPhase_SANDBOX_PHASE_STOPPED {
		if s.Phase == PhaseCreating {
			_, err = r.gateway.StartSandbox(ctx, target, s.SandboxName)
			return err
		}
		return fmt.Errorf("sandbox stopped unexpectedly; session restart is required")
	}
	if phase == openshellpb.SandboxPhase_SANDBOX_PHASE_ERROR {
		return fmt.Errorf("gateway reports a sandbox error")
	}
	if phase != openshellpb.SandboxPhase_SANDBOX_PHASE_READY {
		return nil
	}
	if err := r.applyManagedNetworkPolicy(ctx, target, s.SandboxName); err != nil {
		return err
	}
	return r.reconcileManagedProcess(ctx, sdk, projectSDK, s, agent, plan, target)
}

func (r *ManagedReconciler) managedEnvironment(s types.Session, agent *types.Agent, plan *ManagedProviderPlan) map[string]string {
	env := map[string]string{}
	if agent != nil {
		for k, v := range agent.Environment {
			env[k] = v
		}
	}
	for k, v := range plan.Environment {
		env[k] = v
	}
	for k, v := range map[string]string{"SESSION_ID": s.ID, "AGENTIC_SESSION_NAME": s.Name, "AGENTIC_SESSION_NAMESPACE": s.ProjectID, "PROJECT_NAME": s.ProjectID, "AGENT_ID": s.AgentID, "WORKSPACE_PATH": "/sandbox/workspace", "ARTIFACTS_DIR": "artifacts", "AMBIENT_CP_TOKEN_URL": r.cfg.RunnerTokenURL, "AMBIENT_GRPC_URL": r.cfg.RunnerGRPCAddress, "AMBIENT_GRPC_ENABLED": "true", "AMBIENT_GRPC_USE_TLS": "true", "HOME": "/sandbox", "LOG_LEVEL": r.runnerCfg.RunnerLogLevel, "STOP_ON_RUN_FINISHED": strconv.FormatBool(s.StopOnRunFinished), "LLM_MODEL": s.LlmModel} {
		env[k] = v
	}
	delete(env, "AMBIENT_TOKEN")
	delete(env, "AMBIENT_API_TOKEN")
	delete(env, "AMBIENT_RUNNER_BOOTSTRAP_TOKEN")
	delete(env, "AMBIENT_ALLOW_INSECURE_RUNNER_TRANSPORT")
	if plan.InferenceProvider != "" {
		for _, key := range []string{"USE_VERTEX", "CLAUDE_CODE_USE_VERTEX", "GOOGLE_APPLICATION_CREDENTIALS", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION"} {
			delete(env, key)
		}
		env["ACP_OPENSHELL_INFERENCE"] = "true"
		env["ANTHROPIC_BASE_URL"] = "https://inference.local"
		env["ANTHROPIC_API_KEY"] = "notused"
		env["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"] = "1"
	}
	if env["LLM_MODEL"] == "" && agent != nil {
		env["LLM_MODEL"] = agent.LlmModel
	}
	if len(r.caPEM) > 0 {
		env["AMBIENT_GRPC_CA_CERT_FILE"] = managedCAPath
		env["AMBIENT_CP_CA_CERT_FILE"] = managedCAPath
	}
	if s.Repos != "" {
		env["REPOS_JSON"] = s.Repos
	} else if s.RepoURL != "" {
		data, _ := json.Marshal([]map[string]string{{"url": s.RepoURL}})
		env["REPOS_JSON"] = string(data)
	}
	if s.StartTime != nil {
		env["IS_RESUME"] = "true"
	}
	return env
}

func (r *ManagedReconciler) managedNetworkRule() (*sandboxpb.NetworkPolicyRule, error) {
	u, err := url.Parse(r.cfg.RunnerTokenURL)
	if err != nil {
		return nil, err
	}
	port := uint32(443)
	if u.Port() != "" {
		n, err := strconv.ParseUint(u.Port(), 10, 16)
		if err != nil {
			return nil, err
		}
		port = uint32(n)
	}
	host, grpcPort, err := net.SplitHostPort(r.cfg.RunnerGRPCAddress)
	if err != nil {
		return nil, err
	}
	n, err := strconv.ParseUint(grpcPort, 10, 16)
	if err != nil {
		return nil, err
	}
	return &sandboxpb.NetworkPolicyRule{Name: "acp-session-callbacks", Endpoints: []*sandboxpb.NetworkEndpoint{{Host: u.Hostname(), Port: port}, {Host: host, Port: uint32(n)}}, Binaries: []*sandboxpb.NetworkBinary{{Path: managedPython}, {Path: "/sandbox/.venv/bin/python3"}, {Path: "/sandbox/.uv/python/cpython-*/bin/python*"}}}, nil
}

func (r *ManagedReconciler) applyManagedNetworkPolicy(ctx context.Context, target, name string) error {
	rule, err := r.managedNetworkRule()
	if err != nil {
		return err
	}
	_, err = r.gateway.UpdateConfig(ctx, target, &openshellpb.UpdateConfigRequest{Name: name, MergeOperations: []*openshellpb.PolicyMergeOperation{{Operation: &openshellpb.PolicyMergeOperation_AddRule{AddRule: &openshellpb.AddNetworkRule{RuleName: acpInternalPolicyKey, Rule: rule}}}}})
	return err
}

type managedProcessState struct {
	State    string `json:"state"`
	ExitCode int    `json:"exit_code"`
}

func (r *ManagedReconciler) reconcileManagedProcess(ctx context.Context, sdk, projectSDK *sdkclient.Client, s types.Session, agent *types.Agent, plan *ManagedProviderPlan, target string) error {
	// The lock and result files are on the persistent sandbox volume. A new
	// control plane process can adopt the same generation without running it twice.
	payloads := []openshell.Payload{{Path: managedRunnerPath, Content: managedRunnerScript}}
	payloads = append(payloads, plan.Payloads...)
	if len(r.caPEM) > 0 {
		payloads = append(payloads, openshell.Payload{Path: managedCAPath, Content: string(r.caPEM)})
	}
	if err := r.gateway.UploadPayloads(ctx, target, s.SandboxID, payloads); err != nil {
		return err
	}
	response, err := r.gateway.ExecSandbox(ctx, target, &openshellpb.ExecSandboxRequest{SandboxId: s.SandboxID, Command: []string{managedPython, managedRunnerPath, "status", s.RunnerGeneration}, TimeoutSeconds: 15})
	if err != nil {
		return err
	}
	if response.ExitCode != 0 {
		return fmt.Errorf("runner status command exited %d", response.ExitCode)
	}
	var state managedProcessState
	if err := json.Unmarshal(response.Stdout, &state); err != nil {
		return fmt.Errorf("runner status is not valid JSON")
	}
	if state.State == "exited" {
		phase := PhaseCompleted
		if state.ExitCode != 0 {
			phase = PhaseFailed
		}
		_, err := r.patchSession(ctx, sdk, s, map[string]interface{}{"phase": phase, "expected_phase": s.Phase, "runtime_status": "Stopping", "completion_time": time.Now().UTC().Format(time.RFC3339Nano)})
		return err
	}
	if state.State == "conflict" {
		return fmt.Errorf("another runner generation is still active")
	}
	if state.State != "missing" && state.State != "running" {
		return fmt.Errorf("runner returned an unknown process state")
	}
	// A lost process after a reported Running state needs an explicit restart.
	// The control plane must not repeat a task after an unknown process failure.
	if state.State == "missing" && s.Phase == PhaseRunning {
		_, err := r.patchSession(ctx, sdk, s, map[string]interface{}{"phase": PhaseFailed, "expected_phase": s.Phase, "runtime_error": "Runner process was lost. Restart the session.", "runtime_status": "Stopping"})
		return err
	}
	if state.State == "missing" {
		helper := &SimpleKubeReconciler{factory: r.factory, cfg: r.runnerCfg, logger: r.logger}
		var extra []types.Payload
		if agent != nil {
			extra = agent.Payloads
		}
		extra = helper.appendInitialPromptPayload(ctx, s, projectSDK, extra)
		converted, _ := convertPayloads(extra, r.logger, s.SandboxName)
		if err := r.gateway.UploadPayloads(ctx, target, s.SandboxID, converted); err != nil {
			return err
		}
		bootstrap, err := tokenserver.IssueBootstrap(r.privateKey, s.ID, s.ProjectID, s.SandboxName, s.RunnerGeneration, 7*24*time.Hour)
		if err != nil {
			return err
		}
		env := r.managedEnvironment(s, agent, plan)
		env["AMBIENT_RUNNER_BOOTSTRAP_TOKEN"] = bootstrap
		command := append([]string{managedPython, managedRunnerPath, "start", s.RunnerGeneration}, helper.resolveEntrypoint(agent)...)
		response, err = r.gateway.ExecSandbox(ctx, target, &openshellpb.ExecSandboxRequest{SandboxId: s.SandboxID, Command: command, Environment: env, TimeoutSeconds: 20})
		if err != nil {
			return err
		}
		if response.ExitCode != 0 {
			return fmt.Errorf("runner launch exited %d", response.ExitCode)
		}
	}
	if s.Phase != PhaseRunning {
		_, err := r.patchSession(ctx, sdk, s, map[string]interface{}{"phase": PhaseRunning, "expected_phase": s.Phase, "runtime_status": "Running", "runtime_error": "", "start_time": time.Now().UTC().Format(time.RFC3339Nano)})
		return err
	}
	if s.RuntimeError != "" {
		_, err := r.patchSession(ctx, sdk, s, map[string]interface{}{"runtime_error": ""})
		return err
	}
	return nil
}

func (r *ManagedReconciler) stopManagedSession(ctx context.Context, sdk *sdkclient.Client, s types.Session, target string) error {
	if s.RuntimeStatus == "Stopped" {
		return nil
	}
	response, err := r.gateway.GetSandbox(ctx, target, s.SandboxName)
	if err != nil && status.Code(err) != codes.NotFound {
		return err
	}
	if err == nil && response.Sandbox.GetStatus().GetPhase() != openshellpb.SandboxPhase_SANDBOX_PHASE_STOPPED {
		_, err = r.gateway.StopSandbox(ctx, target, s.SandboxName)
		return err
	}
	phase := s.Phase
	if phase == PhaseStopping {
		phase = PhaseStopped
	}
	_, err = r.patchSession(ctx, sdk, s, map[string]interface{}{"phase": phase, "expected_phase": s.Phase, "runner_generation": "", "runtime_status": "Stopped", "runtime_error": ""})
	return err
}

func (r *ManagedReconciler) deleteManagedSession(ctx context.Context, sdk *sdkclient.Client, s types.Session) error {
	if s.GatewayID == "" {
		_, err := r.patchSession(ctx, sdk, s, map[string]interface{}{"runtime_status": "Deleted", "runner_generation": ""})
		return err
	}
	target := openshell.TargetKey(s.GatewayID, s.GatewayWorkspace)
	_, err := r.gateway.GetSandbox(ctx, target, s.SandboxName)
	if err == nil {
		if err := r.gateway.DeleteSandbox(ctx, target, s.SandboxName); err != nil {
			return err
		}
		_, err = r.patchSession(ctx, sdk, s, map[string]interface{}{"runtime_status": "Deleting", "runner_generation": ""})
		return err
	}
	if status.Code(err) != codes.NotFound {
		return err
	}
	if err := r.gateway.DeleteWorkspace(ctx, target, s.GatewayWorkspace); err != nil && status.Code(err) != codes.NotFound {
		return err
	}
	_, err = r.patchSession(ctx, sdk, s, map[string]interface{}{"runtime_status": "Deleted", "runner_generation": "", "runtime_error": ""})
	return err
}
