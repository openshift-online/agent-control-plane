package reconciler

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/ambient-code/platform/components/ambient-control-plane/internal/gateway"
	"github.com/ambient-code/platform/components/ambient-control-plane/internal/kubeclient"
	sdkclient "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/client"
	"github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	"github.com/rs/zerolog"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

const (
	gatewaySyncInterval = 30 * time.Second
	gatewayManifestsDir = "/manifests/gateway"
)

type GatewayReconciler struct {
	factory             *SDKClientFactory
	dynamicClient       dynamic.Interface
	clientset           *kubernetes.Clientset
	provisioner         kubeclient.NamespaceProvisioner
	logger              zerolog.Logger
	manifests           map[string][]*unstructured.Unstructured
	defaultGatewayImage string
}

func NewGatewayReconciler(
	factory *SDKClientFactory,
	dynamicClient dynamic.Interface,
	clientset *kubernetes.Clientset,
	provisioner kubeclient.NamespaceProvisioner,
	logger zerolog.Logger,
) *GatewayReconciler {
	defaultImage := os.Getenv("OPENSHELL_GATEWAY_IMAGE")
	if defaultImage == "" {
		defaultImage = "ghcr.io/nvidia/openshell/gateway:0.0.83"
	}
	return &GatewayReconciler{
		factory:             factory,
		dynamicClient:       dynamicClient,
		clientset:           clientset,
		provisioner:         provisioner,
		logger:              logger.With().Str("component", "gateway-reconciler").Logger(),
		defaultGatewayImage: defaultImage,
	}
}

func (r *GatewayReconciler) Run(ctx context.Context) error {
	manifests, err := gateway.LoadGatewayManifests(gatewayManifestsDir)
	if err != nil {
		return fmt.Errorf("load gateway manifests: %w", err)
	}
	r.manifests = manifests
	r.logger.Info().
		Int("manifest_files", len(manifests)).
		Dur("interval", gatewaySyncInterval).
		Msg("gateway reconciler started")

	ticker := time.NewTicker(gatewaySyncInterval)
	defer ticker.Stop()

	r.reconcileOnce(ctx)

	for {
		select {
		case <-ctx.Done():
			r.logger.Info().Msg("gateway reconciler stopped")
			return ctx.Err()
		case <-ticker.C:
			r.reconcileOnce(ctx)
		}
	}
}

func (r *GatewayReconciler) reconcileOnce(ctx context.Context) {
	serviceClient, err := r.buildServiceClient(ctx)
	if err != nil {
		r.logger.Error().Err(err).Msg("failed to create service client for project listing")
		return
	}

	projects, err := r.listAllProjects(ctx, serviceClient)
	if err != nil {
		r.logger.Error().Err(err).Msg("failed to list projects")
		return
	}

	var totalGateways, failedGateways int
	for _, project := range projects {
		count, failures, reconcileErr := r.reconcileProjectGateways(ctx, project)
		if reconcileErr != nil {
			r.logger.Error().Err(reconcileErr).Str("project_id", project.ID).Msg("failed to reconcile project gateways")
			continue
		}
		totalGateways += count
		failedGateways += failures
	}

	logEvent := r.logger.Debug().Int("projects", len(projects)).Int("gateways", totalGateways)
	if failedGateways > 0 {
		logEvent = r.logger.Warn().Int("projects", len(projects)).Int("gateways", totalGateways).Int("failed", failedGateways)
	}
	logEvent.Msg("gateway reconciliation complete")
}

func (r *GatewayReconciler) buildServiceClient(ctx context.Context) (*sdkclient.Client, error) {
	token, err := r.factory.Token(ctx)
	if err != nil {
		return nil, fmt.Errorf("resolve token: %w", err)
	}
	return sdkclient.NewServiceClient(r.factory.BaseURL(), token, sdkclient.WithTimeout(sdkClientTimeout))
}

func (r *GatewayReconciler) listAllProjects(ctx context.Context, client *sdkclient.Client) ([]types.Project, error) {
	var all []types.Project
	page := 1
	for {
		opts := types.NewListOptions().Page(page).Size(100).Build()
		list, err := client.Projects().List(ctx, opts)
		if err != nil {
			return nil, fmt.Errorf("list projects page %d: %w", page, err)
		}
		all = append(all, list.Items...)
		if len(all) >= list.Total || len(list.Items) == 0 {
			break
		}
		page++
	}
	return all, nil
}

func (r *GatewayReconciler) reconcileProjectGateways(ctx context.Context, project types.Project) (int, int, error) {
	projectClient, err := r.factory.ForProject(ctx, project.ID)
	if err != nil {
		return 0, 0, fmt.Errorf("create SDK client for project %s: %w", project.ID, err)
	}

	gateways, err := r.listAllGateways(ctx, projectClient)
	if err != nil {
		return 0, 0, fmt.Errorf("list gateways in project %s: %w", project.ID, err)
	}

	namespace := r.provisioner.NamespaceName(project.ID)

	var failures int
	for i := range gateways {
		gw := &gateways[i]
		if reconcileErr := r.reconcileGateway(ctx, projectClient, gw, namespace); reconcileErr != nil {
			failures++
			r.logger.Error().Err(reconcileErr).
				Str("gateway_id", gw.ID).
				Str("gateway_name", gw.Name).
				Str("project_id", project.ID).
				Msg("failed to reconcile gateway")
			r.updateGatewayAnnotation(ctx, projectClient, gw, "ambient.ai/reconcile-status", "Failed: "+sanitizeAnnotationValue(reconcileErr.Error()))
		}
	}

	return len(gateways), failures, nil
}

func (r *GatewayReconciler) listAllGateways(ctx context.Context, client *sdkclient.Client) ([]types.Gateway, error) {
	var all []types.Gateway
	page := 1
	for {
		opts := types.NewListOptions().Page(page).Size(100).Build()
		list, err := client.Gateways().List(ctx, opts)
		if err != nil {
			return nil, fmt.Errorf("list gateways page %d: %w", page, err)
		}
		all = append(all, list.Items...)
		if len(all) >= list.Total || len(list.Items) == 0 {
			break
		}
		page++
	}
	return all, nil
}

func (r *GatewayReconciler) reconcileGateway(ctx context.Context, projectClient *sdkclient.Client, gw *types.Gateway, namespace string) error {
	resolvedDnsNames := make([]string, len(gw.ServerDnsNames))
	for i, dns := range gw.ServerDnsNames {
		resolvedDnsNames[i] = strings.ReplaceAll(dns, "NAMESPACE_PLACEHOLDER", namespace)
	}

	gwConfig := gateway.GatewayConfig{
		Image:          gw.Image,
		ServerDnsNames: resolvedDnsNames,
		Config:         gw.Config,
	}

	if gw.Oidc != nil && gw.Oidc.Issuer != "" {
		gwConfig.Oidc = &gateway.OidcConfig{
			Issuer:      gw.Oidc.Issuer,
			Audience:    gw.Oidc.Audience,
			JwksTtl:     gw.Oidc.JwksTtl,
			RolesClaim:  gw.Oidc.RolesClaim,
			AdminRole:   gw.Oidc.AdminRole,
			UserRole:    gw.Oidc.UserRole,
			ScopesClaim: gw.Oidc.ScopesClaim,
		}
	}

	if err := gateway.ValidateGatewayConfig(gwConfig); err != nil {
		r.logger.Warn().Err(err).
			Str("gateway_name", gw.Name).
			Msg("invalid gateway configuration, skipping")
		r.updateGatewayAnnotation(ctx, projectClient, gw, "ambient.ai/reconcile-status", "ValidationFailed: "+sanitizeAnnotationValue(err.Error()))
		return nil
	}

	nsConfig := gateway.NamespaceConfig{
		Name:    namespace,
		Gateway: gwConfig,
	}

	if err := gateway.ReconcileGateways(ctx, r.dynamicClient, r.clientset, []gateway.NamespaceConfig{nsConfig}, r.manifests); err != nil {
		return fmt.Errorf("reconcile gateway %s: %w", gw.Name, err)
	}

	r.logger.Info().
		Str("gateway_name", gw.Name).
		Str("image", resolveGatewayImage(gwConfig.Image, r.defaultGatewayImage)).
		Int("dns_names", len(gw.ServerDnsNames)).
		Msg("gateway reconciled")

	r.updateGatewayAnnotation(ctx, projectClient, gw, "ambient.ai/reconcile-status", "Synced")
	return nil
}

func (r *GatewayReconciler) updateGatewayAnnotation(ctx context.Context, client *sdkclient.Client, gw *types.Gateway, key, value string) {
	annotations := make(map[string]string)
	if gw.Annotations != "" {
		_ = json.Unmarshal([]byte(gw.Annotations), &annotations)
	}

	if annotations[key] == value {
		return
	}

	annotations[key] = value
	annotations["ambient.ai/last-reconciled-at"] = time.Now().UTC().Format(time.RFC3339)
	annJSON, err := json.Marshal(annotations)
	if err != nil {
		r.logger.Warn().Err(err).Str("gateway_id", gw.ID).Msg("failed to marshal gateway annotations")
		return
	}

	patch := map[string]interface{}{"annotations": string(annJSON)}
	if _, err := client.Gateways().Update(ctx, gw.ID, patch); err != nil {
		r.logger.Warn().Err(err).Str("gateway_id", gw.ID).Msg("failed to update gateway reconcile status")
	}
}

func resolveGatewayImage(configImage, defaultImage string) string {
	if configImage != "" {
		return configImage
	}
	return defaultImage
}

const maxAnnotationValueLen = 256

func sanitizeAnnotationValue(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	if len(s) > maxAnnotationValueLen {
		s = s[:maxAnnotationValueLen]
	}
	return s
}
