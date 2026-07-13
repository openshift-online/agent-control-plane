package reconciler

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/ambient-code/platform/components/ambient-control-plane/internal/kubeclient"
	"github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell"
	openshellpb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	sdkclient "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/client"
	"github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	"github.com/rs/zerolog"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

const (
	podSyncInterval    = 15 * time.Second
	managedLabelFilter = LabelManaged + "=true," + LabelManagedBy + "=ambient-control-plane"
)

type PodStatusSyncer struct {
	factory            *SDKClientFactory
	kube               *kubeclient.KubeClient
	gateway            *openshell.GatewayClient
	useGateway         bool
	platformMode       string
	mppConfigNamespace string
	logger             zerolog.Logger
	errorFirstSeen     map[string]time.Time
}

func NewPodStatusSyncer(factory *SDKClientFactory, kube *kubeclient.KubeClient, gateway *openshell.GatewayClient, useGateway bool, platformMode, mppConfigNamespace string, logger zerolog.Logger) *PodStatusSyncer {
	return &PodStatusSyncer{
		factory:            factory,
		kube:               kube,
		gateway:            gateway,
		useGateway:         useGateway,
		platformMode:       platformMode,
		mppConfigNamespace: mppConfigNamespace,
		logger:             logger.With().Str("component", "pod-status-syncer").Logger(),
		errorFirstSeen:     make(map[string]time.Time),
	}
}

func (s *PodStatusSyncer) Run(ctx context.Context) error {
	s.logger.Info().Dur("interval", podSyncInterval).Msg("pod status syncer started")
	ticker := time.NewTicker(podSyncInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			s.logger.Info().Msg("pod status syncer stopped")
			return ctx.Err()
		case <-ticker.C:
			s.syncOnce(ctx)
		}
	}
}

func (s *PodStatusSyncer) syncOnce(ctx context.Context) {
	if s.useGateway {
		s.syncGatewaySandboxes(ctx)
		return
	}

	namespaces, err := s.listManagedNamespaces(ctx)
	if err != nil {
		s.logger.Warn().Err(err).Msg("failed to list managed namespaces")
		return
	}

	for _, ns := range namespaces {
		s.syncNamespace(ctx, ns)
	}
}

func (s *PodStatusSyncer) listManagedNamespaces(ctx context.Context) ([]string, error) {
	if s.platformMode == "mpp" {
		return s.listMPPManagedNamespaces(ctx)
	}
	nsList, err := s.kube.ListNamespacesByLabel(ctx, managedLabelFilter)
	if err != nil {
		return nil, fmt.Errorf("listing managed namespaces: %w", err)
	}

	var names []string
	for _, ns := range nsList.Items {
		names = append(names, ns.GetName())
	}
	return names, nil
}

func (s *PodStatusSyncer) listMPPManagedNamespaces(ctx context.Context) ([]string, error) {
	tnList, err := s.kube.ListTenantNamespaces(ctx, s.mppConfigNamespace, managedLabelFilter)
	if err != nil {
		return nil, fmt.Errorf("listing managed TenantNamespaces in %s: %w", s.mppConfigNamespace, err)
	}

	var names []string
	for _, tn := range tnList.Items {
		names = append(names, "ambient-code--"+tn.GetName())
	}
	return names, nil
}

func (s *PodStatusSyncer) syncNamespace(ctx context.Context, namespace string) {
	pods, err := s.kube.ListPodsByLabel(ctx, namespace, managedLabelFilter)
	if err != nil {
		s.logger.Warn().Err(err).Str("namespace", namespace).Msg("failed to list pods")
		return
	}

	for i := range pods.Items {
		s.syncPod(ctx, namespace, &pods.Items[i])
	}
}

func (s *PodStatusSyncer) syncGatewaySandboxes(ctx context.Context) {
	nsList, err := s.kube.ListNamespacesByLabel(ctx, managedLabelFilter)
	if err != nil {
		s.logger.Warn().Err(err).Msg("failed to list managed namespaces for sandbox sync")
		return
	}

	for _, ns := range nsList.Items {
		namespace := ns.GetName()
		projectID := ns.GetLabels()[LabelProjectID]
		if projectID == "" {
			continue
		}
		s.syncProjectSandboxes(ctx, namespace, projectID)
	}
}

func (s *PodStatusSyncer) syncProjectSandboxes(ctx context.Context, namespace, projectID string) {
	sdk, err := s.factory.ForProject(ctx, projectID)
	if err != nil {
		s.logger.Warn().Err(err).Str("project_id", projectID).Msg("failed to get SDK client for sandbox sync")
		return
	}

	opts := types.NewListOptions().Size(100).Build()
	sessionList, err := sdk.Sessions().List(ctx, opts)
	if err != nil {
		s.logger.Warn().Err(err).Str("project_id", projectID).Msg("failed to list sessions for sandbox sync")
		return
	}

	for i := range sessionList.Items {
		session := &sessionList.Items[i]
		if session.Phase == PhaseRunning || session.Phase == PhaseCreating {
			s.syncSandboxStatus(ctx, sdk, namespace, session)
		}
	}
}

func (s *PodStatusSyncer) syncSandboxStatus(ctx context.Context, sdk *sdkclient.Client, namespace string, session *types.Session) {
	if isTerminalPhase(session.Phase) {
		return
	}

	sbxName := openshell.SandboxName(session.ID)
	resp, err := s.gateway.GetSandbox(ctx, namespace, sbxName)
	if err != nil {
		if st, ok := status.FromError(err); ok && st.Code() == codes.NotFound {
			if session.Phase == PhaseRunning || session.Phase == PhaseCreating {
				s.logger.Warn().Str("session_id", session.ID).Str("sandbox", sbxName).Msg("sandbox not found, marking session failed")
				s.updateSessionPhase(ctx, sdk, session, PhaseFailed, nil)
			}
			return
		}
		s.logger.Warn().Err(err).Str("session_id", session.ID).Str("sandbox", sbxName).Msg("failed to get sandbox status")
		return
	}

	s.snapshotSandboxData(ctx, sdk, namespace, session, resp)

	desiredPhase := mapSandboxPhaseToSessionPhase(resp.Sandbox.Status.Phase)
	if desiredPhase == "" {
		delete(s.errorFirstSeen, session.ID)
		return
	}

	if desiredPhase != PhaseFailed {
		delete(s.errorFirstSeen, session.ID)
	}

	if desiredPhase == PhaseFailed && session.Phase == PhaseCreating {
		first, tracked := s.errorFirstSeen[session.ID]
		if !tracked {
			s.errorFirstSeen[session.ID] = time.Now()
			s.logger.Warn().
				Str("session_id", session.ID).
				Msg("sandbox error during creation, starting grace period")
			return
		}
		if time.Since(first) < sandboxErrorGracePeriod {
			s.logger.Debug().
				Str("session_id", session.ID).
				Dur("error_duration", time.Since(first)).
				Msg("sandbox error within grace period, skipping failure")
			return
		}
		s.logger.Error().
			Str("session_id", session.ID).
			Dur("error_duration", time.Since(first)).
			Msg("sandbox error exceeded grace period")
		delete(s.errorFirstSeen, session.ID)
	}

	if session.Phase == desiredPhase {
		return
	}

	if session.Phase == PhaseStopping && desiredPhase == PhaseCompleted {
		desiredPhase = PhaseStopped
	}

	s.updateSessionPhase(ctx, sdk, session, desiredPhase, nil)
}

func (s *PodStatusSyncer) snapshotSandboxData(ctx context.Context, sdk *sdkclient.Client, namespace string, session *types.Session, resp *openshellpb.SandboxResponse) {
	sbx := resp.GetSandbox()
	if sbx == nil {
		return
	}

	patch, patchErr := openshell.BuildSnapshotPatch(sbx)
	if patchErr != nil {
		s.logger.Warn().Err(patchErr).Str("session_id", session.ID).Msg("snapshot: failed to build patch")
		return
	}

	sandboxID := sbx.GetMetadata().GetId()
	if sandboxID != "" {
		logs, logErr := s.gateway.FetchSandboxLogs(ctx, namespace, sandboxID, openshell.LogTailLines)
		if logErr != nil {
			s.logger.Debug().Err(logErr).Str("session_id", session.ID).Msg("snapshot: failed to fetch logs")
		}
		if len(logs) > 0 {
			logsJSON, marshalErr := json.Marshal(logs)
			if marshalErr == nil {
				patch["sandbox_logs_snapshot"] = string(logsJSON)
			}
		}
	}

	if _, err := sdk.Sessions().UpdateStatus(ctx, session.ID, patch); err != nil {
		s.logger.Warn().Err(err).Str("session_id", session.ID).Msg("snapshot: failed to persist sandbox data")
	}
}

func mapSandboxPhaseToSessionPhase(phase openshellpb.SandboxPhase) string {
	switch phase {
	case openshellpb.SandboxPhase_SANDBOX_PHASE_PROVISIONING:
		return PhaseCreating
	case openshellpb.SandboxPhase_SANDBOX_PHASE_READY:
		return PhaseRunning
	case openshellpb.SandboxPhase_SANDBOX_PHASE_ERROR:
		return PhaseFailed
	case openshellpb.SandboxPhase_SANDBOX_PHASE_DELETING:
		return PhaseStopping
	default:
		return ""
	}
}

func (s *PodStatusSyncer) syncPod(ctx context.Context, namespace string, pod *unstructured.Unstructured) {
	labels := pod.GetLabels()
	sessionID := labels["ambient-code.io/session-id"]
	projectID := labels[LabelProjectID]
	if sessionID == "" || projectID == "" {
		return
	}

	podPhase, _, _ := unstructured.NestedString(pod.Object, "status", "phase")
	desiredSessionPhase := s.mapPodPhaseToSessionPhase(podPhase, pod)
	if desiredSessionPhase == "" {
		return
	}

	sdk, err := s.factory.ForProject(ctx, projectID)
	if err != nil {
		s.logger.Warn().Err(err).Str("session_id", sessionID).Msg("failed to get SDK client")
		return
	}

	session, err := sdk.Sessions().Get(ctx, sessionID)
	if err != nil {
		s.logger.Debug().Err(err).Str("session_id", sessionID).Msg("session not found in API")
		return
	}

	if isTerminalPhase(session.Phase) {
		return
	}

	if session.Phase == desiredSessionPhase {
		return
	}

	if session.Phase == PhaseStopping && desiredSessionPhase == PhaseCompleted {
		desiredSessionPhase = PhaseStopped
	}

	s.updateSessionPhase(ctx, sdk, session, desiredSessionPhase, pod)
}

func (s *PodStatusSyncer) mapPodPhaseToSessionPhase(podPhase string, pod *unstructured.Unstructured) string {
	switch podPhase {
	case "Succeeded":
		return PhaseCompleted
	case "Failed":
		return PhaseFailed
	case "Pending":
		if s.hasContainerCrashLoop(pod) {
			return PhaseFailed
		}
		return ""
	case "Running":
		if s.hasContainerCrashLoop(pod) {
			return PhaseFailed
		}
		if s.hasRunnerContainerExited(pod) {
			return PhaseCompleted
		}
		return PhaseRunning
	default:
		return ""
	}
}

func (s *PodStatusSyncer) hasRunnerContainerExited(pod *unstructured.Unstructured) bool {
	statuses, found, _ := unstructured.NestedSlice(pod.Object, "status", "containerStatuses")
	if !found {
		return false
	}
	for _, cs := range statuses {
		csMap, ok := cs.(map[string]interface{})
		if !ok {
			continue
		}
		name, _, _ := unstructured.NestedString(csMap, "name")
		if name != "ambient-code-runner" {
			continue
		}
		terminated, found, _ := unstructured.NestedMap(csMap, "state", "terminated")
		if found {
			reason, _, _ := unstructured.NestedString(terminated, "reason")
			if reason == "Completed" {
				return true
			}
		}
	}
	return false
}

func (s *PodStatusSyncer) hasContainerCrashLoop(pod *unstructured.Unstructured) bool {
	statuses, found, _ := unstructured.NestedSlice(pod.Object, "status", "containerStatuses")
	if !found {
		return false
	}

	for _, cs := range statuses {
		csMap, ok := cs.(map[string]interface{})
		if !ok {
			continue
		}
		restartCount, _, _ := unstructured.NestedInt64(csMap, "restartCount")
		if restartCount >= 5 {
			return true
		}
		waiting, found, _ := unstructured.NestedMap(csMap, "state", "waiting")
		if found {
			reason, _, _ := unstructured.NestedString(waiting, "reason")
			if reason == "CrashLoopBackOff" || reason == "ImagePullBackOff" || reason == "ErrImagePull" {
				return true
			}
		}
		name, _, _ := unstructured.NestedString(csMap, "name")
		terminated, found, _ := unstructured.NestedMap(csMap, "state", "terminated")
		if found && name == "ambient-code-runner" {
			reason, _, _ := unstructured.NestedString(terminated, "reason")
			if reason == "OOMKilled" || reason == "Error" {
				return true
			}
		}
	}

	initStatuses, found, _ := unstructured.NestedSlice(pod.Object, "status", "initContainerStatuses")
	if !found {
		return false
	}

	for _, cs := range initStatuses {
		csMap, ok := cs.(map[string]interface{})
		if !ok {
			continue
		}
		waiting, found, _ := unstructured.NestedMap(csMap, "state", "waiting")
		if found {
			reason, _, _ := unstructured.NestedString(waiting, "reason")
			if reason == "CrashLoopBackOff" || reason == "ImagePullBackOff" || reason == "ErrImagePull" {
				return true
			}
		}
	}
	return false
}

func (s *PodStatusSyncer) updateSessionPhase(ctx context.Context, sdk *sdkclient.Client, session *types.Session, newPhase string, pod *unstructured.Unstructured) {
	patch := map[string]interface{}{"phase": newPhase}

	if newPhase == PhaseRunning {
		if session.StartTime == nil {
			now := time.Now()
			patch["start_time"] = &now
		}
		patch["conditions"] = emptyConditionsJSON
	}

	if newPhase == PhaseCompleted || newPhase == PhaseFailed || newPhase == PhaseStopped {
		now := time.Now()
		patch["completion_time"] = &now
	}

	if newPhase == PhaseFailed && pod != nil {
		if conditionsJSON := s.buildFailureConditions(pod); conditionsJSON != "" {
			patch["conditions"] = conditionsJSON
		}
	}

	if _, err := sdk.Sessions().UpdateStatus(ctx, session.ID, patch); err != nil {
		s.logger.Warn().Err(err).
			Str("session_id", session.ID).
			Str("from_phase", session.Phase).
			Str("to_phase", newPhase).
			Msg("failed to update session phase from pod status")
		return
	}

	s.logger.Info().
		Str("session_id", session.ID).
		Str("from_phase", session.Phase).
		Str("to_phase", newPhase).
		Msg("session phase updated from pod status")
}

func (s *PodStatusSyncer) buildFailureConditions(pod *unstructured.Unstructured) string {
	var conditions []map[string]interface{}

	for _, statusField := range []string{"containerStatuses", "initContainerStatuses"} {
		statuses, found, _ := unstructured.NestedSlice(pod.Object, "status", statusField)
		if !found {
			continue
		}
		for _, cs := range statuses {
			csMap, ok := cs.(map[string]interface{})
			if !ok {
				continue
			}
			if terminated, found, _ := unstructured.NestedMap(csMap, "state", "terminated"); found {
				reason, _, _ := unstructured.NestedString(terminated, "reason")
				message, _, _ := unstructured.NestedString(terminated, "message")
				exitCode, _, _ := unstructured.NestedInt64(terminated, "exitCode")

				if reason == "Error" || reason == "OOMKilled" || exitCode != 0 {
					msg := message
					if msg == "" {
						msg = fmt.Sprintf("Session terminated with error (exit code %d)", exitCode)
					}
					conditions = append(conditions, map[string]interface{}{
						"type":               "ContainerFailed",
						"status":             "False",
						"reason":             reason,
						"message":            msg,
						"lastTransitionTime": time.Now().UTC().Format(time.RFC3339),
					})
				}
			}

			if waiting, found, _ := unstructured.NestedMap(csMap, "state", "waiting"); found {
				reason, _, _ := unstructured.NestedString(waiting, "reason")
				message, _, _ := unstructured.NestedString(waiting, "message")
				if reason == "CrashLoopBackOff" || reason == "ImagePullBackOff" || reason == "ErrImagePull" {
					msg := message
					if msg == "" {
						msg = "Session failed to start"
					}
					conditions = append(conditions, map[string]interface{}{
						"type":               "ContainerFailed",
						"status":             "False",
						"reason":             "StartupFailed",
						"message":            msg,
						"lastTransitionTime": time.Now().UTC().Format(time.RFC3339),
					})
				}
			}
		}
	}

	if len(conditions) == 0 {
		return ""
	}

	data, err := json.Marshal(conditions)
	if err != nil {
		s.logger.Error().Err(err).Msg("failed to marshal pod failure conditions")
		return ""
	}
	return string(data)
}

func isTerminalPhase(phase string) bool {
	for _, tp := range TerminalPhases {
		if phase == tp {
			return true
		}
	}
	return false
}
