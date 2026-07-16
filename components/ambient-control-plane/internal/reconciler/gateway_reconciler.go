package reconciler

import (
	"context"
	"encoding/base64"
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
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

const (
	gatewaySyncInterval = 30 * time.Second
	gatewayManifestsDir = "/manifests/gateway"
)

var routeGVR = schema.GroupVersionResource{
	Group:    "route.openshift.io",
	Version:  "v1",
	Resource: "routes",
}

type GatewayReconciler struct {
	factory             *SDKClientFactory
	dynamicClient       dynamic.Interface
	clientset           *kubernetes.Clientset
	provisioner         kubeclient.NamespaceProvisioner
	logger              zerolog.Logger
	manifests           map[string][]*unstructured.Unstructured
	defaultGatewayImage string
	isOpenShift         bool
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
	r.isOpenShift = r.detectOpenShift()
	r.logger.Info().
		Int("manifest_files", len(manifests)).
		Bool("openshift", r.isOpenShift).
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

	if gw.Route != nil {
		gwConfig.Route = &gateway.RouteConfig{
			Host: gw.Route.Host,
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

	if err := r.reconcileRoute(ctx, projectClient, gw, namespace); err != nil {
		r.logger.Warn().Err(err).
			Str("gateway_name", gw.Name).
			Msg("route reconciliation failed, gateway resources are synced")
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

func (r *GatewayReconciler) detectOpenShift() bool {
	_, resources, err := r.clientset.Discovery().ServerGroupsAndResources()
	if err != nil {
		r.logger.Warn().Err(err).Msg("failed to discover API groups, assuming non-OpenShift")
		return false
	}
	for _, list := range resources {
		if strings.HasPrefix(list.GroupVersion, "route.openshift.io/") {
			return true
		}
	}
	return false
}

func (r *GatewayReconciler) reconcileRoute(ctx context.Context, projectClient *sdkclient.Client, gw *types.Gateway, namespace string) error {
	if !r.isOpenShift {
		return nil
	}

	routeName := "openshell-gateway"

	if gw.Route == nil {
		return r.deleteRouteIfExists(ctx, projectClient, gw, namespace, routeName)
	}

	caCert, err := r.readCACert(ctx, namespace)
	if err != nil {
		r.logger.Debug().Err(err).Str("namespace", namespace).Msg("CA cert not yet available, will retry next cycle")
		return nil
	}

	stsUID, err := r.getStatefulSetUID(ctx, namespace, routeName)
	if err != nil {
		r.logger.Debug().Err(err).Str("namespace", namespace).Msg("StatefulSet not yet available for OwnerReference")
		stsUID = ""
	}

	routeObj, err := r.buildRouteObject(gw, namespace, routeName, caCert, stsUID)
	if err != nil {
		return fmt.Errorf("build route object: %w", err)
	}

	existing, err := r.dynamicClient.Resource(routeGVR).Namespace(namespace).Get(ctx, routeName, metav1.GetOptions{})
	if err != nil {
		if !k8serrors.IsNotFound(err) {
			return fmt.Errorf("get route: %w", err)
		}
		if _, createErr := r.dynamicClient.Resource(routeGVR).Namespace(namespace).Create(ctx, routeObj, metav1.CreateOptions{}); createErr != nil {
			return fmt.Errorf("create route: %w", createErr)
		}
		r.logger.Info().Str("namespace", namespace).Msg("created OpenShift Route for gateway")
	} else {
		routeObj.SetResourceVersion(existing.GetResourceVersion())
		if _, updateErr := r.dynamicClient.Resource(routeGVR).Namespace(namespace).Update(ctx, routeObj, metav1.UpdateOptions{}); updateErr != nil {
			return fmt.Errorf("update route: %w", updateErr)
		}
	}

	return r.reconcileRouteAddress(ctx, projectClient, gw, namespace, routeName)
}

func (r *GatewayReconciler) buildRouteObject(gw *types.Gateway, namespace, routeName, caCert, stsUID string) (*unstructured.Unstructured, error) {
	host := ""
	if gw.Route != nil {
		host = gw.Route.Host
	}

	route := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "route.openshift.io/v1",
			"kind":       "Route",
			"metadata": map[string]interface{}{
				"name":      routeName,
				"namespace": namespace,
				"labels": map[string]interface{}{
					"app.kubernetes.io/name":       "openshell",
					"app.kubernetes.io/component":  "gateway",
					"app.kubernetes.io/managed-by": "agent-control-plane",
				},
				"annotations": map[string]interface{}{
					"haproxy.router.openshift.io/timeout": "3600s",
				},
			},
			"spec": map[string]interface{}{
				"to": map[string]interface{}{
					"kind":   "Service",
					"name":   routeName,
					"weight": int64(100),
				},
				"port": map[string]interface{}{
					"targetPort": "grpc",
				},
				"tls": map[string]interface{}{
					"termination":                  "reencrypt",
					"insecureEdgeTerminationPolicy": "None",
					"destinationCACertificate":      caCert,
				},
			},
		},
	}

	if host != "" {
		if err := unstructured.SetNestedField(route.Object, host, "spec", "host"); err != nil {
			return nil, fmt.Errorf("set route host: %w", err)
		}
	}

	if stsUID != "" {
		ownerRefs := []interface{}{
			map[string]interface{}{
				"apiVersion":         "apps/v1",
				"kind":               "StatefulSet",
				"name":               routeName,
				"uid":                stsUID,
				"controller":         true,
				"blockOwnerDeletion": true,
			},
		}
		if err := unstructured.SetNestedSlice(route.Object, ownerRefs, "metadata", "ownerReferences"); err != nil {
			return nil, fmt.Errorf("set route ownerReferences: %w", err)
		}
	}

	return route, nil
}

func (r *GatewayReconciler) readCACert(ctx context.Context, namespace string) (string, error) {
	secretGVR := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "secrets"}
	secret, err := r.dynamicClient.Resource(secretGVR).Namespace(namespace).Get(ctx, "openshell-server-tls", metav1.GetOptions{})
	if err != nil {
		return "", fmt.Errorf("get openshell-server-tls: %w", err)
	}

	data, found, err := unstructured.NestedMap(secret.Object, "data")
	if err != nil {
		return "", fmt.Errorf("read openshell-server-tls data: %w", err)
	}
	if !found {
		return "", fmt.Errorf("openshell-server-tls has no data field")
	}

	caCertB64, ok := data["ca.crt"].(string)
	if !ok || caCertB64 == "" {
		return "", fmt.Errorf("openshell-server-tls missing ca.crt")
	}

	decoded, err := base64.StdEncoding.DecodeString(caCertB64)
	if err != nil {
		return "", fmt.Errorf("decode ca.crt: %w", err)
	}

	return string(decoded), nil
}

func (r *GatewayReconciler) getStatefulSetUID(ctx context.Context, namespace, name string) (string, error) {
	stsGVR := schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "statefulsets"}
	sts, err := r.dynamicClient.Resource(stsGVR).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", fmt.Errorf("get statefulset %s: %w", name, err)
	}
	return string(sts.GetUID()), nil
}

func (r *GatewayReconciler) reconcileRouteAddress(ctx context.Context, projectClient *sdkclient.Client, gw *types.Gateway, namespace, routeName string) error {
	route, err := r.dynamicClient.Resource(routeGVR).Namespace(namespace).Get(ctx, routeName, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("get route for address reconciliation: %w", err)
	}

	ingress, found, err := unstructured.NestedSlice(route.Object, "status", "ingress")
	if err != nil {
		return fmt.Errorf("read route status ingress: %w", err)
	}
	if !found || len(ingress) == 0 {
		return nil
	}

	firstIngress, ok := ingress[0].(map[string]interface{})
	if !ok {
		return nil
	}

	host, _, err := unstructured.NestedString(firstIngress, "host")
	if err != nil {
		return fmt.Errorf("read route ingress host: %w", err)
	}
	if host == "" {
		return nil
	}

	routeAddress := "https://" + host
	if gw.RouteAddress == routeAddress {
		return nil
	}

	patch := types.NewGatewayPatchBuilder().RouteAddress(routeAddress).Build()
	if _, err := projectClient.Gateways().Update(ctx, gw.ID, patch); err != nil {
		return fmt.Errorf("update routeAddress for gateway %s: %w", gw.ID, err)
	}

	r.logger.Info().
		Str("gateway_name", gw.Name).
		Str("route_address", routeAddress).
		Msg("updated gateway routeAddress")
	return nil
}

func (r *GatewayReconciler) deleteRouteIfExists(ctx context.Context, projectClient *sdkclient.Client, gw *types.Gateway, namespace, routeName string) error {
	_, err := r.dynamicClient.Resource(routeGVR).Namespace(namespace).Get(ctx, routeName, metav1.GetOptions{})
	if err != nil {
		if k8serrors.IsNotFound(err) {
			return nil
		}
		return fmt.Errorf("get route for deletion: %w", err)
	}

	if err := r.dynamicClient.Resource(routeGVR).Namespace(namespace).Delete(ctx, routeName, metav1.DeleteOptions{}); err != nil && !k8serrors.IsNotFound(err) {
		return fmt.Errorf("delete route: %w", err)
	}

	r.logger.Info().Str("namespace", namespace).Msg("deleted OpenShift Route for gateway")

	if gw.RouteAddress != "" {
		patch := types.NewGatewayPatchBuilder().RouteAddress("").Build()
		if _, patchErr := projectClient.Gateways().Update(ctx, gw.ID, patch); patchErr != nil {
			return fmt.Errorf("clear routeAddress for gateway %s: %w", gw.ID, patchErr)
		}
	}

	return nil
}
