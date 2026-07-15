package gateway

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/rs/zerolog/log"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/util/yaml"
)

// LoadGatewayManifests reads all YAML files from manifestsDir
// Returns map[filename][]*unstructured.Unstructured
func LoadGatewayManifests(manifestsDir string) (map[string][]*unstructured.Unstructured, error) {
	manifests := make(map[string][]*unstructured.Unstructured)

	entries, err := os.ReadDir(manifestsDir)
	if err != nil {
		return nil, fmt.Errorf("read manifests directory: %w", err)
	}

	requiredFiles := []string{"serviceaccount.yaml", "configmap.yaml", "service.yaml", "rbac.yaml"}
	foundFiles := make(map[string]bool)

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".yaml") {
			continue
		}

		filePath := filepath.Join(manifestsDir, entry.Name())
		data, err := os.ReadFile(filePath)
		if err != nil {
			return nil, fmt.Errorf("read manifest file %s: %w", entry.Name(), err)
		}

		// Parse YAML documents (may contain multiple resources separated by ---)
		decoder := yaml.NewYAMLOrJSONDecoder(strings.NewReader(string(data)), 4096)
		var resources []*unstructured.Unstructured

		for {
			obj := &unstructured.Unstructured{}
			if err := decoder.Decode(obj); err != nil {
				if err.Error() == "EOF" {
					break
				}
				return nil, fmt.Errorf("decode manifest %s: %w", entry.Name(), err)
			}

			// Skip empty documents
			if obj.Object == nil || len(obj.Object) == 0 {
				continue
			}

			resources = append(resources, obj)
		}

		manifests[entry.Name()] = resources
		foundFiles[entry.Name()] = true

		log.Debug().
			Str("file", entry.Name()).
			Int("resources", len(resources)).
			Msg("loaded gateway manifest")
	}

	// Verify required files exist
	for _, required := range requiredFiles {
		if !foundFiles[required] {
			return nil, fmt.Errorf("required manifest file not found: %s", required)
		}
	}

	totalResources := 0
	for _, resources := range manifests {
		totalResources += len(resources)
	}

	log.Info().
		Int("files", len(manifests)).
		Int("resources", totalResources).
		Msg("loaded gateway manifests")

	return manifests, nil
}

// ApplyManifestToNamespace substitutes NAMESPACE_PLACEHOLDER and IMAGE_PLACEHOLDER
// and returns a copy of the manifest ready to apply
func ApplyManifestToNamespace(manifest *unstructured.Unstructured, namespace string, config GatewayConfig, defaultImage string) (*unstructured.Unstructured, error) {
	// Deep copy to avoid mutating original
	obj := manifest.DeepCopy()

	// Convert to JSON for string replacement
	jsonBytes, err := obj.MarshalJSON()
	if err != nil {
		return nil, fmt.Errorf("marshal manifest: %w", err)
	}

	manifestJSON := string(jsonBytes)

	// Replace NAMESPACE_PLACEHOLDER
	manifestJSON = strings.ReplaceAll(manifestJSON, "NAMESPACE_PLACEHOLDER", namespace)

	// Replace IMAGE_PLACEHOLDER
	// Priority: config.Image > defaultImage (from env var)
	image := defaultImage
	if config.Image != "" {
		image = config.Image
	}
	manifestJSON = strings.ReplaceAll(manifestJSON, "IMAGE_PLACEHOLDER", image)

	// Unmarshal back to unstructured
	result := &unstructured.Unstructured{}
	if err := result.UnmarshalJSON([]byte(manifestJSON)); err != nil {
		return nil, fmt.Errorf("unmarshal manifest: %w", err)
	}

	return result, nil
}

// ApplyConfigOverrides applies namespace-specific configuration overrides
// Currently supports: serverDnsNames and custom TOML config
func ApplyConfigOverrides(obj *unstructured.Unstructured, config GatewayConfig) error {
	kind := obj.GetKind()

	// Update ConfigMap with custom TOML if provided
	if kind == "ConfigMap" && obj.GetName() == "openshell-gateway-config" && config.Config != "" {
		data, found, err := unstructured.NestedMap(obj.Object, "data")
		if err != nil || !found {
			return fmt.Errorf("configmap data not found")
		}
		data["gateway.toml"] = config.Config
		if err := unstructured.SetNestedMap(obj.Object, data, "data"); err != nil {
			return fmt.Errorf("set configmap data: %w", err)
		}
	}

	// Inject OIDC configuration into gateway.toml (works with both default and custom configs)
	if kind == "ConfigMap" && obj.GetName() == "openshell-gateway-config" && config.Oidc != nil && config.Oidc.Issuer != "" {
		data, found, err := unstructured.NestedMap(obj.Object, "data")
		if err != nil || !found {
			return fmt.Errorf("configmap data not found")
		}

		toml, ok := data["gateway.toml"].(string)
		if !ok {
			return fmt.Errorf("gateway.toml not found in configmap")
		}

		// Flip allow_unauthenticated_users to false when OIDC is enabled
		toml = strings.ReplaceAll(toml, "allow_unauthenticated_users = true", "allow_unauthenticated_users = false")

		// Disable mTLS (client certificate verification) — OIDC clients authenticate
		// via Bearer tokens, not client certificates.
		lines := strings.Split(toml, "\n")
		filtered := lines[:0]
		for _, line := range lines {
			if !strings.Contains(line, "client_ca_path") {
				filtered = append(filtered, line)
			}
		}
		toml = strings.Join(filtered, "\n")

		// Append OIDC section if not already present in the config
		if !strings.Contains(toml, "[openshell.gateway.oidc]") {
			oidcSection := "\n[openshell.gateway.oidc]\n"
			oidcSection += fmt.Sprintf("    issuer   = %q\n", config.Oidc.Issuer)
			if config.Oidc.Audience != "" {
				oidcSection += fmt.Sprintf("    audience = %q\n", config.Oidc.Audience)
			}
			if config.Oidc.JwksTtl > 0 {
				oidcSection += fmt.Sprintf("    jwks_ttl = %d\n", config.Oidc.JwksTtl)
			}
			if config.Oidc.RolesClaim != "" {
				oidcSection += fmt.Sprintf("    roles_claim = %q\n", config.Oidc.RolesClaim)
			}
			if config.Oidc.AdminRole != "" {
				oidcSection += fmt.Sprintf("    admin_role = %q\n", config.Oidc.AdminRole)
			}
			if config.Oidc.UserRole != "" {
				oidcSection += fmt.Sprintf("    user_role = %q\n", config.Oidc.UserRole)
			}
			if config.Oidc.ScopesClaim != "" {
				oidcSection += fmt.Sprintf("    scopes_claim = %q\n", config.Oidc.ScopesClaim)
			}
			toml += oidcSection
		}
		data["gateway.toml"] = toml

		if err := unstructured.SetNestedMap(obj.Object, data, "data"); err != nil {
			return fmt.Errorf("set configmap data: %w", err)
		}
	}

	// Update ConfigMap server_sans if serverDnsNames provided (and no custom config)
	if kind == "ConfigMap" && obj.GetName() == "openshell-gateway-config" && len(config.ServerDnsNames) > 0 && config.Config == "" {
		data, found, err := unstructured.NestedMap(obj.Object, "data")
		if err != nil || !found {
			return fmt.Errorf("configmap data not found")
		}

		toml, ok := data["gateway.toml"].(string)
		if !ok {
			return fmt.Errorf("gateway.toml not found in configmap")
		}

		// Build server_sans array
		serverSans := "["
		for i, dns := range config.ServerDnsNames {
			if i > 0 {
				serverSans += ", "
			}
			serverSans += fmt.Sprintf("\"%s\"", dns)
		}
		serverSans += "]"

		// Replace server_sans line in TOML
		lines := strings.Split(toml, "\n")
		for i, line := range lines {
			if strings.Contains(line, "server_sans =") {
				lines[i] = fmt.Sprintf("    server_sans = %s", serverSans)
				break
			}
		}
		data["gateway.toml"] = strings.Join(lines, "\n")

		if err := unstructured.SetNestedMap(obj.Object, data, "data"); err != nil {
			return fmt.Errorf("set configmap data: %w", err)
		}
	}

	// Add image_pull_policy for LOCAL_IMAGES=true (kind-local development)
	if kind == "ConfigMap" && obj.GetName() == "openshell-gateway-config" && os.Getenv("LOCAL_IMAGES") == "true" && config.Config == "" {
		data, found, err := unstructured.NestedMap(obj.Object, "data")
		if err != nil || !found {
			return fmt.Errorf("configmap data not found")
		}

		toml, ok := data["gateway.toml"].(string)
		if !ok {
			return fmt.Errorf("gateway.toml not found in configmap")
		}

		// Append image_pull_policy to [openshell.drivers.kubernetes] section (idempotent)
		if !strings.Contains(toml, "image_pull_policy") {
			lines := strings.Split(toml, "\n")
			for i, line := range lines {
				if strings.Contains(line, `app_armor_profile`) {
					lines = append(lines[:i+1], append([]string{`    image_pull_policy            = "IfNotPresent"`}, lines[i+1:]...)...)
					break
				}
			}
			data["gateway.toml"] = strings.Join(lines, "\n")
		}

		if err := unstructured.SetNestedMap(obj.Object, data, "data"); err != nil {
			return fmt.Errorf("set configmap data: %w", err)
		}
	}

	// Update certgen Job serverDnsNames if provided
	if kind == "Job" && strings.Contains(obj.GetName(), "certgen") && len(config.ServerDnsNames) > 0 {
		containers, found, err := unstructured.NestedSlice(obj.Object, "spec", "template", "spec", "containers")
		if err != nil || !found {
			return nil // Not fatal, job may not have containers yet
		}

		for i, container := range containers {
			containerMap, ok := container.(map[string]interface{})
			if !ok {
				continue
			}

			args, found, _ := unstructured.NestedStringSlice(containerMap, "args")
			if !found {
				continue
			}

			// Remove all existing --server-san arguments
			newArgs := []string{}
			for _, arg := range args {
				if !strings.HasPrefix(arg, "--server-san=") {
					newArgs = append(newArgs, arg)
				}
			}

			// Add --server-san for each DNS name
			for _, dns := range config.ServerDnsNames {
				newArgs = append(newArgs, fmt.Sprintf("--server-san=%s", dns))
			}

			if err := unstructured.SetNestedStringSlice(containerMap, newArgs, "args"); err != nil {
				return fmt.Errorf("set job args: %w", err)
			}

			containers[i] = containerMap
		}

		if err := unstructured.SetNestedSlice(obj.Object, containers, "spec", "template", "spec", "containers"); err != nil {
			return fmt.Errorf("set job containers: %w", err)
		}
	}

	return nil
}
