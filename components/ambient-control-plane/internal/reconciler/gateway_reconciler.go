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

var grpcRouteGVR = schema.GroupVersionResource{
	Group:    "gateway.networking.k8s.io",
	Version:  "v1",
	Resource: "grpcroutes",
}

var backendTLSPolicyGVR = schema.GroupVersionResource{
	Group:    "gateway.networking.k8s.io",
	Version:  "v1",
	Resource: "backendtlspolicies",
}

var configMapGVR = schema.GroupVersionResource{
	Group:    "",
	Version:  "v1",
	Resource: "configmaps",
}

var gatewayGVR = schema.GroupVersionResource{
	Group:    "gateway.networking.k8s.io",
	Version:  "v1",
	Resource: "gateways",
}

const (
	trustedCAConfigMapName = "gateway-trusted-ca"
	trustedCAKey           = "ca-bundle.crt"
)

type GatewayReconciler struct {
	factory                    *SDKClientFactory
	dynamicClient              dynamic.Interface
	clientset                  *kubernetes.Clientset
	provisioner                kubeclient.NamespaceProvisioner
	logger                     zerolog.Logger
	manifests                  map[string][]*unstructured.Unstructured
	defaultGatewayImage        string
	cpNamespace                string
	isOpenShift                bool
	hasCertManager             bool
	hasGatewayAPI              bool
	gatewayAPIGatewayName      string
	gatewayAPIGatewayNamespace string
	baseDomain                 string
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
	cpNs := os.Getenv("NAMESPACE")
	if cpNs == "" {
		cpNs = "ambient-code"
	}
	gwAPIName := os.Getenv("GATEWAY_API_GATEWAY_NAME")
	if gwAPIName == "" {
		gwAPIName = "acpgw"
	}
	gwAPINamespace := os.Getenv("GATEWAY_API_GATEWAY_NAMESPACE")
	if gwAPINamespace == "" {
		gwAPINamespace = "openshift-ingress"
	}
	return &GatewayReconciler{
		factory:                    factory,
		dynamicClient:              dynamicClient,
		clientset:                  clientset,
		provisioner:                provisioner,
		logger:                     logger.With().Str("component", "gateway-reconciler").Logger(),
		defaultGatewayImage:        defaultImage,
		cpNamespace:                cpNs,
		gatewayAPIGatewayName:      gwAPIName,
		gatewayAPIGatewayNamespace: gwAPINamespace,
	}
}

func (r *GatewayReconciler) Run(ctx context.Context) error {
	manifests, err := gateway.LoadGatewayManifests(gatewayManifestsDir)
	if err != nil {
		return fmt.Errorf("load gateway manifests: %w", err)
	}
	r.manifests = manifests
	r.isOpenShift = r.detectOpenShift()
	r.hasCertManager = r.detectCertManager()
	r.baseDomain = r.detectBaseDomain(ctx)
	r.hasGatewayAPI = r.detectGatewayAPI(ctx)
	r.logger.Info().
		Int("manifest_files", len(manifests)).
		Bool("openshift", r.isOpenShift).
		Bool("cert_manager", r.hasCertManager).
		Bool("gateway_api", r.hasGatewayAPI).
		Str("base_domain", r.baseDomain).
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

	opts := gateway.ReconcileOpts{
		IsOpenShift:    r.isOpenShift,
		HasCertManager: r.hasCertManager,
	}

	if caData, err := r.reconcileTrustedCA(ctx, namespace); err != nil {
		r.logger.Warn().Err(err).Str("namespace", namespace).Msg("failed to propagate trusted CA, gateway may not trust private CAs")
	} else {
		opts.TrustedCAData = caData
	}

	if err := gateway.ReconcileGateways(ctx, r.dynamicClient, r.clientset, []gateway.NamespaceConfig{nsConfig}, r.manifests, opts); err != nil {
		return fmt.Errorf("reconcile gateway %s: %w", gw.Name, err)
	}

	if r.isOpenShift {
		if err := r.reconcileOpenShiftSCC(ctx, namespace); err != nil {
			r.logger.Warn().Err(err).Str("namespace", namespace).Msg("failed to reconcile OpenShift SCC binding")
		}
	}

	if r.hasCertManager {
		if err := r.reconcileCertManagerResources(ctx, gw, namespace); err != nil {
			r.logger.Warn().Err(err).Str("namespace", namespace).Msg("cert-manager resource reconciliation failed, certgen job handles fallback")
		}
	}

	if err := r.reconcileGRPCRoute(ctx, projectClient, gw, namespace); err != nil {
		r.logger.Warn().Err(err).
			Str("gateway_name", gw.Name).
			Msg("GRPCRoute reconciliation failed, gateway resources are synced")
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
	var annotations map[string]string
	if gw.Annotations != "" {
		if err := json.Unmarshal([]byte(gw.Annotations), &annotations); err != nil {
			annotations = make(map[string]string)
		}
	} else {
		annotations = make(map[string]string)
	}

	if annotations[key] == value {
		return
	}

	annotations[key] = value
	annotations["ambient.ai/last-reconciled-at"] = time.Now().UTC().Format(time.RFC3339)

	raw, err := json.Marshal(annotations)
	if err != nil {
		r.logger.Warn().Err(err).Str("gateway_id", gw.ID).Msg("failed to marshal annotations")
		return
	}

	patch := map[string]interface{}{"annotations": string(raw)}
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

func (r *GatewayReconciler) reconcileGRPCRoute(ctx context.Context, projectClient *sdkclient.Client, gw *types.Gateway, namespace string) error {
	if !r.hasGatewayAPI {
		return nil
	}

	routeName := "openshell-gateway"

	if gw.Route == nil {
		return r.deleteGRPCRouteIfExists(ctx, projectClient, gw, namespace, routeName)
	}

	hostname := gw.Route.Host
	if hostname == "" && r.baseDomain != "" {
		hostname = fmt.Sprintf("%s-%s.acpgw.%s", gw.Name, namespace, r.baseDomain)
	}
	if hostname == "" {
		r.logger.Debug().Str("gateway_name", gw.Name).Msg("no hostname available for GRPCRoute, skipping")
		return nil
	}

	stsUID, err := r.getStatefulSetUID(ctx, namespace, routeName)
	if err != nil {
		r.logger.Info().Err(err).Str("namespace", namespace).Msg("StatefulSet not yet available, creating GRPCRoute without OwnerReference (will be set on next reconcile)")
		stsUID = ""
	}

	grpcRoute, err := r.buildGRPCRouteObject(namespace, routeName, hostname, stsUID)
	if err != nil {
		return fmt.Errorf("build GRPCRoute: %w", err)
	}
	if err := r.applyUnstructured(ctx, grpcRouteGVR, namespace, routeName, grpcRoute); err != nil {
		return fmt.Errorf("apply GRPCRoute: %w", err)
	}

	caCert, err := r.readCACert(ctx, namespace)
	if err != nil {
		r.logger.Debug().Err(err).Str("namespace", namespace).Msg("server TLS secret not yet available, skipping BackendTLSPolicy")
	} else {
		caConfigMap := r.buildCAConfigMap(namespace, routeName, stsUID, caCert)
		if err := r.applyUnstructured(ctx, configMapGVR, namespace, "openshell-backend-ca", caConfigMap); err != nil {
			return fmt.Errorf("apply CA ConfigMap: %w", err)
		}

		tlsPolicy := r.buildBackendTLSPolicy(namespace, routeName, stsUID)
		if err := r.applyUnstructured(ctx, backendTLSPolicyGVR, namespace, routeName, tlsPolicy); err != nil {
			r.logger.Warn().Err(err).Msg("failed to apply BackendTLSPolicy (CRD may not be available)")
		}
	}

	return r.reconcileGRPCRouteAddress(ctx, projectClient, gw, hostname)
}

func (r *GatewayReconciler) buildGRPCRouteObject(namespace, routeName, hostname, stsUID string) (*unstructured.Unstructured, error) {
	route := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "gateway.networking.k8s.io/v1",
			"kind":       "GRPCRoute",
			"metadata": map[string]interface{}{
				"name":      routeName,
				"namespace": namespace,
				"labels": map[string]interface{}{
					"app.kubernetes.io/name":       "openshell",
					"app.kubernetes.io/component":  "gateway",
					"app.kubernetes.io/managed-by": "agent-control-plane",
				},
			},
			"spec": map[string]interface{}{
				"parentRefs": []interface{}{
					map[string]interface{}{
						"name":      r.gatewayAPIGatewayName,
						"namespace": r.gatewayAPIGatewayNamespace,
					},
				},
				"hostnames": []interface{}{hostname},
				"rules": []interface{}{
					map[string]interface{}{
						"backendRefs": []interface{}{
							map[string]interface{}{
								"name": routeName,
								"port": int64(8080),
							},
						},
					},
				},
			},
		},
	}

	if stsUID != "" {
		ownerRefs := []interface{}{
			map[string]interface{}{
				"apiVersion": "apps/v1",
				"kind":       "StatefulSet",
				"name":       routeName,
				"uid":        stsUID,
				"controller": true,
			},
		}
		if err := unstructured.SetNestedSlice(route.Object, ownerRefs, "metadata", "ownerReferences"); err != nil {
			return nil, fmt.Errorf("set GRPCRoute ownerReferences: %w", err)
		}
	}

	return route, nil
}

func (r *GatewayReconciler) buildBackendTLSPolicy(namespace, routeName, stsUID string) *unstructured.Unstructured {
	metadata := map[string]interface{}{
		"name":      routeName,
		"namespace": namespace,
		"labels": map[string]interface{}{
			"app.kubernetes.io/name":       "openshell",
			"app.kubernetes.io/component":  "gateway",
			"app.kubernetes.io/managed-by": "agent-control-plane",
		},
	}
	if stsUID != "" {
		metadata["ownerReferences"] = []interface{}{
			map[string]interface{}{
				"apiVersion": "apps/v1",
				"kind":       "StatefulSet",
				"name":       routeName,
				"uid":        stsUID,
				"controller": true,
			},
		}
	}
	return &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "gateway.networking.k8s.io/v1",
			"kind":       "BackendTLSPolicy",
			"metadata":   metadata,
			"spec": map[string]interface{}{
				"targetRefs": []interface{}{
					map[string]interface{}{
						"group": "",
						"kind":  "Service",
						"name":  routeName,
					},
				},
				"validation": map[string]interface{}{
					"caCertificateRefs": []interface{}{
						map[string]interface{}{
							"group": "",
							"kind":  "ConfigMap",
							"name":  "openshell-backend-ca",
						},
					},
					"hostname": fmt.Sprintf("%s.%s.svc.cluster.local", routeName, namespace),
				},
			},
		},
	}
}

func (r *GatewayReconciler) buildCAConfigMap(namespace, routeName, stsUID, caCert string) *unstructured.Unstructured {
	metadata := map[string]interface{}{
		"name":      "openshell-backend-ca",
		"namespace": namespace,
		"labels": map[string]interface{}{
			"app.kubernetes.io/name":       "openshell",
			"app.kubernetes.io/component":  "gateway",
			"app.kubernetes.io/managed-by": "agent-control-plane",
		},
	}
	if stsUID != "" {
		metadata["ownerReferences"] = []interface{}{
			map[string]interface{}{
				"apiVersion": "apps/v1",
				"kind":       "StatefulSet",
				"name":       routeName,
				"uid":        stsUID,
				"controller": true,
			},
		}
	}
	return &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "ConfigMap",
			"metadata":   metadata,
			"data": map[string]interface{}{
				"ca.crt": caCert,
			},
		},
	}
}

func (r *GatewayReconciler) applyUnstructured(ctx context.Context, gvr schema.GroupVersionResource, namespace, name string, obj *unstructured.Unstructured) error {
	existing, err := r.dynamicClient.Resource(gvr).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if !k8serrors.IsNotFound(err) {
			return fmt.Errorf("get %s/%s: %w", gvr.Resource, name, err)
		}
		if _, createErr := r.dynamicClient.Resource(gvr).Namespace(namespace).Create(ctx, obj, metav1.CreateOptions{}); createErr != nil {
			return fmt.Errorf("create %s/%s: %w", gvr.Resource, name, createErr)
		}
		r.logger.Info().Str("namespace", namespace).Str("resource", gvr.Resource).Str("name", name).Msg("created resource")
		return nil
	}
	obj.SetResourceVersion(existing.GetResourceVersion())
	if _, err := r.dynamicClient.Resource(gvr).Namespace(namespace).Update(ctx, obj, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("update %s/%s: %w", gvr.Resource, name, err)
	}
	return nil
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

func (r *GatewayReconciler) reconcileGRPCRouteAddress(ctx context.Context, projectClient *sdkclient.Client, gw *types.Gateway, hostname string) error {
	protocol := r.getGatewayListenerProtocol(ctx)
	routeAddress := protocol + "://" + hostname

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

func (r *GatewayReconciler) getGatewayListenerProtocol(ctx context.Context) string {
	gw, err := r.dynamicClient.Resource(gatewayGVR).Namespace(r.gatewayAPIGatewayNamespace).Get(
		ctx, r.gatewayAPIGatewayName, metav1.GetOptions{})
	if err != nil {
		r.logger.Warn().Err(err).Msg("failed to read networking Gateway for protocol detection, defaulting to http")
		return "http"
	}

	listeners, _, err := unstructured.NestedSlice(gw.Object, "spec", "listeners")
	if err != nil {
		r.logger.Warn().Err(err).Msg("failed to read Gateway listeners, defaulting to http")
		return "http"
	}
	for _, l := range listeners {
		listener, ok := l.(map[string]interface{})
		if !ok {
			continue
		}
		proto, _, _ := unstructured.NestedString(listener, "protocol")
		if strings.EqualFold(proto, "HTTPS") || strings.EqualFold(proto, "TLS") {
			return "https"
		}
	}
	return "http"
}

func (r *GatewayReconciler) detectGatewayAPI(ctx context.Context) bool {
	_, resources, err := r.clientset.Discovery().ServerGroupsAndResources()
	if err != nil {
		r.logger.Warn().Err(err).Msg("failed to discover API groups for Gateway API detection")
		return false
	}
	hasGRPCRoute := false
	for _, list := range resources {
		if list.GroupVersion == "gateway.networking.k8s.io/v1" {
			for _, res := range list.APIResources {
				if res.Name == "grpcroutes" {
					hasGRPCRoute = true
					break
				}
			}
		}
	}
	if !hasGRPCRoute {
		return false
	}

	gw, err := r.dynamicClient.Resource(gatewayGVR).Namespace(r.gatewayAPIGatewayNamespace).Get(
		ctx, r.gatewayAPIGatewayName, metav1.GetOptions{})
	if err != nil {
		if k8serrors.IsNotFound(err) {
			r.logger.Info().
				Str("name", r.gatewayAPIGatewayName).
				Str("namespace", r.gatewayAPIGatewayNamespace).
				Msg("networking Gateway not found, GRPCRoute provisioning disabled")
		} else {
			r.logger.Warn().Err(err).Msg("failed to check networking Gateway")
		}
		return false
	}

	conditions, _, _ := unstructured.NestedSlice(gw.Object, "status", "conditions")
	for _, c := range conditions {
		cond, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		condType, _, _ := unstructured.NestedString(cond, "type")
		condStatus, _, _ := unstructured.NestedString(cond, "status")
		if condType == "Accepted" && condStatus == "True" {
			return true
		}
	}

	r.logger.Info().Msg("networking Gateway exists but is not yet Accepted")
	return false
}

func (r *GatewayReconciler) detectBaseDomain(ctx context.Context) string {
	if domain := os.Getenv("GATEWAY_API_BASE_DOMAIN"); domain != "" {
		return domain
	}

	ingressConfigGVR := schema.GroupVersionResource{
		Group:    "config.openshift.io",
		Version:  "v1",
		Resource: "ingresses",
	}
	cfg, err := r.dynamicClient.Resource(ingressConfigGVR).Get(
		ctx, "cluster", metav1.GetOptions{})
	if err != nil {
		r.logger.Warn().Err(err).Msg("could not read ingresses.config.openshift.io/cluster for base domain")
		return ""
	}
	domain, _, _ := unstructured.NestedString(cfg.Object, "spec", "domain")
	return domain
}

func (r *GatewayReconciler) reconcileTrustedCA(ctx context.Context, tenantNamespace string) (string, error) {
	configMapGVR := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"}

	source, err := r.dynamicClient.Resource(configMapGVR).Namespace(r.cpNamespace).Get(ctx, trustedCAConfigMapName, metav1.GetOptions{})
	if err != nil {
		if k8serrors.IsNotFound(err) {
			return "", nil
		}
		return "", fmt.Errorf("get %s from %s: %w", trustedCAConfigMapName, r.cpNamespace, err)
	}

	data, found, err := unstructured.NestedStringMap(source.Object, "data")
	if err != nil || !found {
		return "", nil
	}

	caData, ok := data[trustedCAKey]
	if !ok || caData == "" {
		return "", nil
	}

	// Copy ConfigMap to tenant namespace (create-or-update)
	target := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "ConfigMap",
			"metadata": map[string]interface{}{
				"name":      trustedCAConfigMapName,
				"namespace": tenantNamespace,
				"labels": map[string]interface{}{
					"app.kubernetes.io/managed-by": "agent-control-plane",
				},
			},
			"data": map[string]interface{}{
				trustedCAKey: caData,
			},
		},
	}

	existing, err := r.dynamicClient.Resource(configMapGVR).Namespace(tenantNamespace).Get(ctx, trustedCAConfigMapName, metav1.GetOptions{})
	if err != nil {
		if !k8serrors.IsNotFound(err) {
			return "", fmt.Errorf("get %s from %s: %w", trustedCAConfigMapName, tenantNamespace, err)
		}
		if _, createErr := r.dynamicClient.Resource(configMapGVR).Namespace(tenantNamespace).Create(ctx, target, metav1.CreateOptions{}); createErr != nil {
			return "", fmt.Errorf("create %s in %s: %w", trustedCAConfigMapName, tenantNamespace, createErr)
		}
		r.logger.Info().Str("namespace", tenantNamespace).Msg("copied gateway-trusted-ca to tenant namespace")
	} else {
		target.SetResourceVersion(existing.GetResourceVersion())
		if _, updateErr := r.dynamicClient.Resource(configMapGVR).Namespace(tenantNamespace).Update(ctx, target, metav1.UpdateOptions{}); updateErr != nil {
			return "", fmt.Errorf("update %s in %s: %w", trustedCAConfigMapName, tenantNamespace, updateErr)
		}
	}

	return caData, nil
}

func (r *GatewayReconciler) detectCertManager() bool {
	_, resources, err := r.clientset.Discovery().ServerGroupsAndResources()
	if err != nil {
		r.logger.Warn().Err(err).Msg("failed to discover API groups for cert-manager detection")
		return false
	}
	for _, list := range resources {
		if strings.HasPrefix(list.GroupVersion, "cert-manager.io/") {
			return true
		}
	}
	return false
}

var (
	issuerGVR = schema.GroupVersionResource{
		Group:    "cert-manager.io",
		Version:  "v1",
		Resource: "issuers",
	}
	certificateGVR = schema.GroupVersionResource{
		Group:    "cert-manager.io",
		Version:  "v1",
		Resource: "certificates",
	}
	roleBindingGVR = schema.GroupVersionResource{
		Group:    "rbac.authorization.k8s.io",
		Version:  "v1",
		Resource: "rolebindings",
	}
)

func (r *GatewayReconciler) reconcileOpenShiftSCC(ctx context.Context, namespace string) error {
	bindingName := "openshell-sandbox-privileged-scc"
	binding := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "rbac.authorization.k8s.io/v1",
			"kind":       "RoleBinding",
			"metadata": map[string]interface{}{
				"name":      bindingName,
				"namespace": namespace,
				"labels": map[string]interface{}{
					"app.kubernetes.io/name":       "openshell",
					"app.kubernetes.io/component":  "gateway",
					"app.kubernetes.io/managed-by": "agent-control-plane",
				},
			},
			"roleRef": map[string]interface{}{
				"apiGroup": "rbac.authorization.k8s.io",
				"kind":     "ClusterRole",
				"name":     "system:openshift:scc:privileged",
			},
			"subjects": []interface{}{
				map[string]interface{}{
					"kind":      "ServiceAccount",
					"name":      "openshell-gateway-sandbox",
					"namespace": namespace,
				},
			},
		},
	}

	existing, err := r.dynamicClient.Resource(roleBindingGVR).Namespace(namespace).Get(ctx, bindingName, metav1.GetOptions{})
	if err != nil {
		if !k8serrors.IsNotFound(err) {
			return fmt.Errorf("get SCC RoleBinding: %w", err)
		}
		if _, createErr := r.dynamicClient.Resource(roleBindingGVR).Namespace(namespace).Create(ctx, binding, metav1.CreateOptions{}); createErr != nil {
			return fmt.Errorf("create SCC RoleBinding: %w", createErr)
		}
		r.logger.Info().Str("namespace", namespace).Msg("created privileged SCC binding for openshell-gateway-sandbox")
		return nil
	}

	binding.SetResourceVersion(existing.GetResourceVersion())
	if _, err := r.dynamicClient.Resource(roleBindingGVR).Namespace(namespace).Update(ctx, binding, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("update SCC RoleBinding: %w", err)
	}
	return nil
}

func (r *GatewayReconciler) reconcileCertManagerResources(ctx context.Context, gw *types.Gateway, namespace string) error {
	dnsNames := []interface{}{
		"openshell-gateway." + namespace + ".svc.cluster.local",
		"localhost",
	}
	for _, dns := range gw.ServerDnsNames {
		resolved := strings.ReplaceAll(dns, "NAMESPACE_PLACEHOLDER", namespace)
		isDuplicate := false
		for _, existing := range dnsNames {
			if existing.(string) == resolved {
				isDuplicate = true
				break
			}
		}
		if !isDuplicate {
			dnsNames = append(dnsNames, resolved)
		}
	}

	resources := []struct {
		gvr  schema.GroupVersionResource
		obj  *unstructured.Unstructured
		desc string
	}{
		{
			gvr: issuerGVR,
			obj: buildCertManagerIssuer("openshell-selfsigned", namespace, map[string]interface{}{
				"selfSigned": map[string]interface{}{},
			}),
			desc: "self-signed Issuer",
		},
		{
			gvr: certificateGVR,
			obj: buildCertManagerCertificate("openshell-ca", namespace, map[string]interface{}{
				"isCA":       true,
				"commonName": "openshell-ca",
				"secretName": "openshell-ca-tls",
				"privateKey": map[string]interface{}{
					"algorithm": "ECDSA",
					"size":      int64(256),
				},
				"issuerRef": map[string]interface{}{
					"name": "openshell-selfsigned",
					"kind": "Issuer",
				},
			}),
			desc: "CA Certificate",
		},
		{
			gvr: issuerGVR,
			obj: buildCertManagerIssuer("openshell-ca-issuer", namespace, map[string]interface{}{
				"ca": map[string]interface{}{
					"secretName": "openshell-ca-tls",
				},
			}),
			desc: "CA Issuer",
		},
		{
			gvr: certificateGVR,
			obj: buildCertManagerCertificate("openshell-server", namespace, map[string]interface{}{
				"secretName": "openshell-server-tls",
				"commonName": "openshell-gateway",
				"dnsNames":   dnsNames,
				"privateKey": map[string]interface{}{
					"rotationPolicy": "Always",
				},
				"issuerRef": map[string]interface{}{
					"name": "openshell-ca-issuer",
					"kind": "Issuer",
				},
			}),
			desc: "server Certificate",
		},
		{
			gvr: certificateGVR,
			obj: buildCertManagerCertificate("openshell-client", namespace, map[string]interface{}{
				"secretName": "openshell-client-tls",
				"commonName": "openshell-client",
				"privateKey": map[string]interface{}{
					"rotationPolicy": "Always",
				},
				"issuerRef": map[string]interface{}{
					"name": "openshell-ca-issuer",
					"kind": "Issuer",
				},
			}),
			desc: "client Certificate",
		},
	}

	for _, res := range resources {
		existing, err := r.dynamicClient.Resource(res.gvr).Namespace(namespace).Get(ctx, res.obj.GetName(), metav1.GetOptions{})
		if err != nil {
			if !k8serrors.IsNotFound(err) {
				return fmt.Errorf("get cert-manager %s: %w", res.desc, err)
			}
			if _, createErr := r.dynamicClient.Resource(res.gvr).Namespace(namespace).Create(ctx, res.obj, metav1.CreateOptions{}); createErr != nil {
				return fmt.Errorf("create cert-manager %s: %w", res.desc, createErr)
			}
			r.logger.Info().Str("namespace", namespace).Str("resource", res.desc).Msg("created cert-manager resource")
			continue
		}

		res.obj.SetResourceVersion(existing.GetResourceVersion())
		if _, err := r.dynamicClient.Resource(res.gvr).Namespace(namespace).Update(ctx, res.obj, metav1.UpdateOptions{}); err != nil {
			return fmt.Errorf("update cert-manager %s: %w", res.desc, err)
		}
	}

	return nil
}

func buildCertManagerIssuer(name, namespace string, spec map[string]interface{}) *unstructured.Unstructured {
	return &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "cert-manager.io/v1",
			"kind":       "Issuer",
			"metadata": map[string]interface{}{
				"name":      name,
				"namespace": namespace,
				"labels": map[string]interface{}{
					"app.kubernetes.io/name":       "openshell",
					"app.kubernetes.io/component":  "gateway",
					"app.kubernetes.io/managed-by": "agent-control-plane",
				},
			},
			"spec": spec,
		},
	}
}

func buildCertManagerCertificate(name, namespace string, spec map[string]interface{}) *unstructured.Unstructured {
	return &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "cert-manager.io/v1",
			"kind":       "Certificate",
			"metadata": map[string]interface{}{
				"name":      name,
				"namespace": namespace,
				"labels": map[string]interface{}{
					"app.kubernetes.io/name":       "openshell",
					"app.kubernetes.io/component":  "gateway",
					"app.kubernetes.io/managed-by": "agent-control-plane",
				},
			},
			"spec": spec,
		},
	}
}

func (r *GatewayReconciler) deleteGRPCRouteIfExists(ctx context.Context, projectClient *sdkclient.Client, gw *types.Gateway, namespace, routeName string) error {
	if err := r.deleteIfExists(ctx, grpcRouteGVR, namespace, routeName); err != nil {
		return fmt.Errorf("delete GRPCRoute: %w", err)
	}

	if err := r.deleteIfExists(ctx, backendTLSPolicyGVR, namespace, routeName); err != nil {
		r.logger.Warn().Err(err).Msg("failed to delete BackendTLSPolicy")
	}

	if err := r.deleteIfExists(ctx, configMapGVR, namespace, "openshell-backend-ca"); err != nil {
		r.logger.Warn().Err(err).Msg("failed to delete CA ConfigMap")
	}

	if gw.RouteAddress != "" {
		patch := types.NewGatewayPatchBuilder().RouteAddress("").Build()
		if _, patchErr := projectClient.Gateways().Update(ctx, gw.ID, patch); patchErr != nil {
			return fmt.Errorf("clear routeAddress for gateway %s: %w", gw.ID, patchErr)
		}
		r.logger.Info().Str("namespace", namespace).Msg("cleared routeAddress and deleted GRPCRoute resources")
	}

	return nil
}

func (r *GatewayReconciler) deleteIfExists(ctx context.Context, gvr schema.GroupVersionResource, namespace, name string) error {
	_, err := r.dynamicClient.Resource(gvr).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if k8serrors.IsNotFound(err) {
			return nil
		}
		return fmt.Errorf("get %s/%s for deletion: %w", gvr.Resource, name, err)
	}
	if err := r.dynamicClient.Resource(gvr).Namespace(namespace).Delete(ctx, name, metav1.DeleteOptions{}); err != nil && !k8serrors.IsNotFound(err) {
		return fmt.Errorf("delete %s/%s: %w", gvr.Resource, name, err)
	}
	return nil
}
