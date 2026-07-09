package gateway

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/rs/zerolog/log"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

// ReconcileGateways ensures gateways are deployed in all configured namespaces
func ReconcileGateways(
	ctx context.Context,
	dynamicClient dynamic.Interface,
	clientset *kubernetes.Clientset,
	namespaceConfigs []NamespaceConfig,
	manifests map[string][]*unstructured.Unstructured,
) error {
	defaultImage := os.Getenv("OPENSHELL_GATEWAY_IMAGE")
	if defaultImage == "" {
		defaultImage = "ghcr.io/nvidia/openshell/gateway:0.0.74" // Fallback
	}

	for _, nsConfig := range namespaceConfigs {
		// 1. Validate namespace exists
		if !namespaceExists(ctx, clientset, nsConfig.Name) {
			log.Warn().
				Str("namespace", nsConfig.Name).
				Msg("namespace not found in cluster, skipping gateway deployment")
			continue
		}

		// 2. Validate gateway configuration
		if err := ValidateGatewayConfig(nsConfig.Gateway); err != nil {
			log.Error().
				Str("namespace", nsConfig.Name).
				Err(err).
				Msg("invalid gateway configuration")
			continue
		}

		// 3. Deploy/update gateway manifests (reconcile pattern)
		if err := deployGateway(ctx, dynamicClient, nsConfig, manifests, defaultImage); err != nil {
			log.Error().
				Str("namespace", nsConfig.Name).
				Err(err).
				Msg("failed to deploy gateway")
			continue // Don't block other namespaces
		}

		log.Info().
			Str("namespace", nsConfig.Name).
			Str("image", defaultImage).
			Msg("gateway reconciled successfully")
	}

	return nil
}

// namespaceExists checks if a namespace exists in the cluster
func namespaceExists(ctx context.Context, clientset *kubernetes.Clientset, namespace string) bool {
	_, err := clientset.CoreV1().Namespaces().Get(ctx, namespace, metav1.GetOptions{})
	return err == nil
}

// deployGateway applies all gateway manifests to the namespace using update-or-create pattern
func deployGateway(
	ctx context.Context,
	dynamicClient dynamic.Interface,
	nsConfig NamespaceConfig,
	manifests map[string][]*unstructured.Unstructured,
	defaultImage string,
) error {
	// Check what changed for THIS namespace
	dnsNamesChanged := false
	configTomlChanged := false

	// Check DNS names
	if len(nsConfig.Gateway.ServerDnsNames) > 0 {
		changed, err := serverDnsNamesChanged(ctx, dynamicClient, nsConfig.Name, nsConfig.Gateway.ServerDnsNames)
		if err != nil {
			log.Warn().Err(err).Msg("failed to check if DNS names changed, assuming changed")
			changed = true // If we can't check, assume changed to be safe
		}
		dnsNamesChanged = changed

		if changed {
			if err := deleteSecretsForCertRegeneration(ctx, dynamicClient, nsConfig.Name); err != nil {
				log.Warn().Err(err).Msg("failed to delete secrets for cert regeneration, continuing anyway")
			}
		}
	}

	// Check custom TOML config
	if nsConfig.Gateway.Config != "" {
		changed, err := gatewayConfigTomlChanged(ctx, dynamicClient, nsConfig.Name, nsConfig.Gateway.Config)
		if err != nil {
			log.Warn().Err(err).Msg("failed to check if config TOML changed, assuming changed")
			changed = true // If we can't check, assume changed to be safe
		}
		configTomlChanged = changed
	}

	// Only restart pods if DNS or config changed (image changes trigger K8s rolling update automatically)
	needsRestart := dnsNamesChanged || configTomlChanged

	// Apply manifests in order: RBAC → ServiceAccount → ConfigMap → Job → Service → StatefulSet → NetworkPolicy
	order := []string{
		"rbac.yaml",
		"serviceaccount.yaml",
		"configmap.yaml",
		"certgen-job.yaml",
		"service.yaml",
		"statefulset.yaml",
		"networkpolicy.yaml",
	}

	for _, filename := range order {
		resources, ok := manifests[filename]
		if !ok {
			log.Warn().
				Str("file", filename).
				Msg("manifest file not found, skipping")
			continue
		}

		for _, manifest := range resources {
			// Apply namespace and image substitutions
			obj, err := ApplyManifestToNamespace(manifest, nsConfig.Name, nsConfig.Gateway, defaultImage)
			if err != nil {
				return fmt.Errorf("apply substitutions for %s: %w", filename, err)
			}

			// Apply config overrides (serverDnsNames, custom TOML)
			if err := ApplyConfigOverrides(obj, nsConfig.Gateway); err != nil {
				return fmt.Errorf("apply config overrides for %s: %w", filename, err)
			}

			// OwnerReferences can't cross namespaces, so we skip setting them for gateway resources
			// Gateway cleanup will be handled by namespace deletion or manual removal from ConfigMap
			// Note: Could use labels for tracking, but OwnerReferences won't work here

			// Reconcile resource (update-or-create)
			if err := reconcileResource(ctx, dynamicClient, obj, needsRestart); err != nil {
				return fmt.Errorf("reconcile resource from %s: %w", filename, err)
			}

			log.Debug().
				Str("namespace", nsConfig.Name).
				Str("kind", obj.GetKind()).
				Str("name", obj.GetName()).
				Msg("reconciled gateway resource")
		}
	}

	return nil
}

// serverDnsNamesChanged checks if the serverDnsNames in the ConfigMap differ from the desired list
func serverDnsNamesChanged(ctx context.Context, dynamicClient dynamic.Interface, namespace string, desiredDnsNames []string) (bool, error) {
	configMapGVR := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"}

	// Get current ConfigMap
	obj, err := dynamicClient.Resource(configMapGVR).Namespace(namespace).Get(ctx, "openshell-gateway-config", metav1.GetOptions{})
	if err != nil {
		if k8serrors.IsNotFound(err) {
			// ConfigMap doesn't exist yet, DNS names are "changed" (new deployment)
			return true, nil
		}
		return false, fmt.Errorf("get openshell-gateway-config: %w", err)
	}

	// Extract gateway.toml from ConfigMap data
	data, found, err := unstructured.NestedMap(obj.Object, "data")
	if err != nil || !found {
		return true, nil // If we can't read it, assume changed
	}

	toml, ok := data["gateway.toml"].(string)
	if !ok {
		return true, nil // If gateway.toml missing, assume changed
	}

	// Extract current server_sans from TOML
	currentDnsNames := extractServerSansFromToml(toml)

	// Compare lists
	if len(currentDnsNames) != len(desiredDnsNames) {
		return true, nil
	}

	// Create maps for order-independent comparison
	currentMap := make(map[string]bool)
	for _, dns := range currentDnsNames {
		currentMap[dns] = true
	}

	for _, dns := range desiredDnsNames {
		if !currentMap[dns] {
			return true, nil
		}
	}

	return false, nil
}

// gatewayConfigTomlChanged checks if the custom TOML config in the ConfigMap differs from the desired config
func gatewayConfigTomlChanged(ctx context.Context, dynamicClient dynamic.Interface, namespace string, desiredConfig string) (bool, error) {
	configMapGVR := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"}

	// Get current ConfigMap
	obj, err := dynamicClient.Resource(configMapGVR).Namespace(namespace).Get(ctx, "openshell-gateway-config", metav1.GetOptions{})
	if err != nil {
		if k8serrors.IsNotFound(err) {
			// ConfigMap doesn't exist yet, config is "changed" (new deployment)
			return true, nil
		}
		return false, fmt.Errorf("get openshell-gateway-config: %w", err)
	}

	// Extract gateway.toml from ConfigMap data
	data, found, err := unstructured.NestedMap(obj.Object, "data")
	if err != nil || !found {
		return true, nil // If we can't read it, assume changed
	}

	currentConfig, ok := data["gateway.toml"].(string)
	if !ok {
		return true, nil // If gateway.toml missing, assume changed
	}

	// Compare configs (simple string comparison)
	return currentConfig != desiredConfig, nil
}

// extractServerSansFromToml parses server_sans array from TOML string
func extractServerSansFromToml(toml string) []string {
	var dnsNames []string

	lines := strings.Split(toml, "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.Contains(trimmed, "server_sans =") {
			// Extract array: server_sans = ["dns1", "dns2", "dns3"]
			start := strings.Index(trimmed, "[")
			end := strings.Index(trimmed, "]")
			if start != -1 && end != -1 && end > start {
				arrayContent := trimmed[start+1 : end]
				// Split by comma and clean quotes
				parts := strings.Split(arrayContent, ",")
				for _, part := range parts {
					cleaned := strings.Trim(strings.TrimSpace(part), "\"")
					if cleaned != "" {
						dnsNames = append(dnsNames, cleaned)
					}
				}
			}
			break
		}
	}

	return dnsNames
}

// deleteSecretsForCertRegeneration deletes TLS secrets and certgen job to force certificate regeneration
// when serverDnsNames change. This is necessary because certgen skips if secrets already exist.
func deleteSecretsForCertRegeneration(ctx context.Context, dynamicClient dynamic.Interface, namespace string) error {
	secretGVR := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "secrets"}
	jobGVR := schema.GroupVersionResource{Group: "batch", Version: "v1", Resource: "jobs"}

	// Delete ALL PKI secrets - certgen fails if partial state exists
	secretsToDelete := []string{
		"openshell-server-tls",
		"openshell-client-tls",
		"openshell-gateway-jwt-keys",
	}

	for _, secretName := range secretsToDelete {
		err := dynamicClient.Resource(secretGVR).Namespace(namespace).Delete(ctx, secretName, metav1.DeleteOptions{})
		if err != nil && !k8serrors.IsNotFound(err) {
			return fmt.Errorf("delete %s secret: %w", secretName, err)
		}
	}

	// Delete certgen job (immutable, needs recreation)
	err := dynamicClient.Resource(jobGVR).Namespace(namespace).Delete(ctx, "openshell-gateway-certgen", metav1.DeleteOptions{
		PropagationPolicy: func() *metav1.DeletionPropagation {
			p := metav1.DeletePropagationBackground
			return &p
		}(),
	})
	if err != nil && !k8serrors.IsNotFound(err) {
		return fmt.Errorf("delete openshell-gateway-certgen job: %w", err)
	}

	log.Info().
		Str("namespace", namespace).
		Msg("deleted all PKI secrets and certgen job for certificate regeneration")

	return nil
}

// reconcileResource creates or updates a Kubernetes resource
func reconcileResource(ctx context.Context, dynamicClient dynamic.Interface, obj *unstructured.Unstructured, needsRestart bool) error {
	gvk := obj.GroupVersionKind()
	gvr := schema.GroupVersionResource{
		Group:    gvk.Group,
		Version:  gvk.Version,
		Resource: kindToResource(gvk.Kind),
	}

	namespace := obj.GetNamespace()
	name := obj.GetName()

	// Determine if resource is namespace-scoped or cluster-scoped
	var resourceClient dynamic.ResourceInterface
	if namespace != "" {
		resourceClient = dynamicClient.Resource(gvr).Namespace(namespace)
	} else {
		resourceClient = dynamicClient.Resource(gvr)
	}

	// Try to get existing resource
	existing, err := resourceClient.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if k8serrors.IsNotFound(err) {
			// Resource doesn't exist, create it
			_, err = resourceClient.Create(ctx, obj, metav1.CreateOptions{})
			if err != nil {
				return fmt.Errorf("create resource: %w", err)
			}
			log.Debug().
				Str("kind", gvk.Kind).
				Str("name", name).
				Str("namespace", namespace).
				Msg("created new resource")
			return nil
		}
		return fmt.Errorf("get resource: %w", err)
	}

	// Jobs are immutable - skip update if already exists
	if gvk.Kind == "Job" {
		log.Debug().
			Str("kind", gvk.Kind).
			Str("name", name).
			Str("namespace", namespace).
			Msg("job already exists, skipping update (jobs are immutable)")
		return nil
	}

	// Resource exists, update it
	// For StatefulSets, add restart annotation ONLY if DNS or config changed
	// (image changes trigger K8s rolling update automatically, no annotation needed)
	if gvk.Kind == "StatefulSet" && needsRestart {
		annotations, _, _ := unstructured.NestedStringMap(obj.Object, "spec", "template", "metadata", "annotations")
		if annotations == nil {
			annotations = make(map[string]string)
		}
		annotations["kubectl.kubernetes.io/restartedAt"] = metav1.Now().Format(time.RFC3339)
		if err := unstructured.SetNestedStringMap(obj.Object, annotations, "spec", "template", "metadata", "annotations"); err != nil {
			log.Warn().Err(err).Msg("failed to add restart annotation, StatefulSet may not restart pods")
		}
		log.Info().
			Str("namespace", namespace).
			Str("name", name).
			Msg("added restart annotation to StatefulSet (DNS or config changed)")
	}

	// For ClusterRoleBindings, merge subjects from existing to support multi-tenant
	if gvk.Kind == "ClusterRoleBinding" {
		mergeClusterRoleBindingSubjects(existing, obj)
	}

	// Preserve resourceVersion for optimistic concurrency
	obj.SetResourceVersion(existing.GetResourceVersion())

	_, err = resourceClient.Update(ctx, obj, metav1.UpdateOptions{})
	if err != nil {
		return fmt.Errorf("update resource: %w", err)
	}

	log.Debug().
		Str("kind", gvk.Kind).
		Str("name", name).
		Str("namespace", namespace).
		Msg("updated existing resource")

	return nil
}

// kindToResource converts Kind to resource name using explicit allowlist
func kindToResource(kind string) string {
	// Explicit mapping for all resource types used in gateway manifests
	mapping := map[string]string{
		"ServiceAccount":     "serviceaccounts",
		"ConfigMap":          "configmaps",
		"Service":            "services",
		"StatefulSet":        "statefulsets",
		"Deployment":         "deployments",
		"Job":                "jobs",
		"Role":               "roles",
		"RoleBinding":        "rolebindings",
		"ClusterRole":        "clusterroles",
		"ClusterRoleBinding": "clusterrolebindings",
		"NetworkPolicy":      "networkpolicies",
		"Secret":             "secrets",
	}

	if resource, ok := mapping[kind]; ok {
		return resource
	}

	// Fallback for unknown types (logged as debug)
	log.Debug().Str("kind", kind).Msg("unknown kind, using naive plural")
	return strings.ToLower(kind) + "s"
}

// mergeClusterRoleBindingSubjects merges subjects from an existing ClusterRoleBinding
// into the desired one, ensuring all tenant namespaces are represented. Without this,
// the last tenant reconciled would overwrite subjects from earlier tenants.
func mergeClusterRoleBindingSubjects(existing, desired *unstructured.Unstructured) {
	existingSubjects, _, _ := unstructured.NestedSlice(existing.Object, "subjects")
	desiredSubjects, _, _ := unstructured.NestedSlice(desired.Object, "subjects")

	// Build a set of subjects already in the desired spec (keyed by SA name + namespace)
	seen := make(map[string]bool)
	for _, s := range desiredSubjects {
		sub, ok := s.(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := sub["name"].(string)
		ns, _ := sub["namespace"].(string)
		seen[name+"/"+ns] = true
	}

	// Add any existing subjects not already present
	for _, s := range existingSubjects {
		sub, ok := s.(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := sub["name"].(string)
		ns, _ := sub["namespace"].(string)
		if !seen[name+"/"+ns] {
			desiredSubjects = append(desiredSubjects, s)
			seen[name+"/"+ns] = true
		}
	}

	_ = unstructured.SetNestedSlice(desired.Object, desiredSubjects, "subjects")
}
