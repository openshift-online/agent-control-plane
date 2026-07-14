package gateway

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestLoadGatewayManifests(t *testing.T) {
	// Create temporary directory with test manifests
	tmpDir := t.TempDir()

	// Create required manifest files
	testManifests := map[string]string{
		"serviceaccount.yaml": `apiVersion: v1
kind: ServiceAccount
metadata:
  name: test-sa
  namespace: NAMESPACE_PLACEHOLDER`,
		"configmap.yaml": `apiVersion: v1
kind: ConfigMap
metadata:
  name: test-cm
  namespace: NAMESPACE_PLACEHOLDER
data:
  key: value`,
		"service.yaml": `apiVersion: v1
kind: Service
metadata:
  name: test-svc
  namespace: NAMESPACE_PLACEHOLDER
spec:
  ports:
  - port: 8080`,
		"rbac.yaml": `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: test-role
  namespace: NAMESPACE_PLACEHOLDER`,
	}

	for filename, content := range testManifests {
		if err := os.WriteFile(filepath.Join(tmpDir, filename), []byte(content), 0644); err != nil {
			t.Fatalf("failed to write test manifest %s: %v", filename, err)
		}
	}

	// Test loading manifests
	manifests, err := LoadGatewayManifests(tmpDir)
	if err != nil {
		t.Fatalf("LoadGatewayManifests() error = %v", err)
	}

	// Verify all required files were loaded
	requiredFiles := []string{"serviceaccount.yaml", "configmap.yaml", "service.yaml", "rbac.yaml"}
	for _, required := range requiredFiles {
		if _, ok := manifests[required]; !ok {
			t.Errorf("LoadGatewayManifests() missing required file: %s", required)
		}
	}

	// Verify manifest count
	if len(manifests) != 4 {
		t.Errorf("LoadGatewayManifests() loaded %d files, want 4", len(manifests))
	}
}

func TestLoadGatewayManifests_MissingRequired(t *testing.T) {
	// Create temporary directory with incomplete manifests
	tmpDir := t.TempDir()

	// Only create one file (missing required files)
	testManifest := `apiVersion: v1
kind: ServiceAccount
metadata:
  name: test-sa`

	if err := os.WriteFile(filepath.Join(tmpDir, "serviceaccount.yaml"), []byte(testManifest), 0644); err != nil {
		t.Fatalf("failed to write test manifest: %v", err)
	}

	// Test loading manifests - should fail due to missing required files
	_, err := LoadGatewayManifests(tmpDir)
	if err == nil {
		t.Error("LoadGatewayManifests() expected error for missing required files, got nil")
	}
}

func TestApplyConfigOverrides_OIDCDisablesMTLS(t *testing.T) {
	configMapJSON := `{
		"apiVersion": "v1",
		"kind": "ConfigMap",
		"metadata": {"name": "openshell-gateway-config", "namespace": "tenant-a"},
		"data": {
			"gateway.toml": "[openshell]\nversion = 1\n\n[openshell.gateway]\nbind_address = \"0.0.0.0:8080\"\n\n[openshell.gateway.tls]\n    cert_path = \"/etc/openshell-tls/server/tls.crt\"\n    key_path = \"/etc/openshell-tls/server/tls.key\"\n    client_ca_path = \"/etc/openshell-tls/client-ca/ca.crt\"\n\n[openshell.gateway.auth]\n    allow_unauthenticated_users = true\n"
		}
	}`

	t.Run("OIDC enabled removes client_ca_path", func(t *testing.T) {
		obj := &unstructured.Unstructured{}
		if err := obj.UnmarshalJSON([]byte(configMapJSON)); err != nil {
			t.Fatalf("failed to unmarshal: %v", err)
		}

		config := GatewayConfig{
			Oidc: &OidcConfig{
				Issuer:   "https://keycloak.example.com/realms/ambient-code",
				Audience: "openshell-cli",
			},
		}

		if err := ApplyConfigOverrides(obj, config); err != nil {
			t.Fatalf("ApplyConfigOverrides() error = %v", err)
		}

		data, _, _ := unstructured.NestedMap(obj.Object, "data")
		toml := data["gateway.toml"].(string)

		if !strings.Contains(toml, "[openshell.gateway.oidc]") {
			t.Error("expected OIDC section in gateway.toml")
		}
		if strings.Contains(toml, "client_ca_path") {
			t.Error("expected client_ca_path to be removed when OIDC is enabled")
		}
		if !strings.Contains(toml, "cert_path") {
			t.Error("expected cert_path to be preserved (server TLS)")
		}
		if !strings.Contains(toml, "key_path") {
			t.Error("expected key_path to be preserved (server TLS)")
		}
		if strings.Contains(toml, "allow_unauthenticated_users = true") {
			t.Error("expected allow_unauthenticated_users to be false when OIDC is enabled")
		}
	})

	t.Run("no OIDC retains client_ca_path", func(t *testing.T) {
		obj := &unstructured.Unstructured{}
		if err := obj.UnmarshalJSON([]byte(configMapJSON)); err != nil {
			t.Fatalf("failed to unmarshal: %v", err)
		}

		config := GatewayConfig{}

		if err := ApplyConfigOverrides(obj, config); err != nil {
			t.Fatalf("ApplyConfigOverrides() error = %v", err)
		}

		data, _, _ := unstructured.NestedMap(obj.Object, "data")
		toml := data["gateway.toml"].(string)

		if strings.Contains(toml, "[openshell.gateway.oidc]") {
			t.Error("expected no OIDC section when OIDC is not configured")
		}
		if !strings.Contains(toml, "client_ca_path") {
			t.Error("expected client_ca_path to be retained when OIDC is not configured")
		}
	})
}

func TestApplyManifestToNamespace(t *testing.T) {
	tests := []struct {
		name         string
		manifestJSON string
		namespace    string
		config       GatewayConfig
		defaultImage string
		checkField   []string
		wantValue    string
	}{
		{
			name: "namespace placeholder substitution",
			manifestJSON: `{
				"apiVersion": "v1",
				"kind": "ServiceAccount",
				"metadata": {
					"name": "test",
					"namespace": "NAMESPACE_PLACEHOLDER"
				}
			}`,
			namespace:  "tenant-a",
			config:     GatewayConfig{},
			checkField: []string{"metadata", "namespace"},
			wantValue:  "tenant-a",
		},
		{
			name: "image placeholder with default",
			manifestJSON: `{
				"apiVersion": "apps/v1",
				"kind": "StatefulSet",
				"metadata": {"name": "gateway"},
				"spec": {
					"template": {
						"spec": {
							"containers": [{
								"name": "gateway",
								"image": "IMAGE_PLACEHOLDER"
							}]
						}
					}
				}
			}`,
			namespace:    "tenant-a",
			config:       GatewayConfig{},
			defaultImage: "ghcr.io/nvidia/openshell/gateway:0.0.71",
			checkField:   []string{"spec", "template", "spec", "containers"},
			wantValue:    "ghcr.io/nvidia/openshell/gateway:0.0.71",
		},
		{
			name: "image placeholder with config override",
			manifestJSON: `{
				"apiVersion": "apps/v1",
				"kind": "StatefulSet",
				"metadata": {"name": "gateway"},
				"spec": {
					"template": {
						"spec": {
							"containers": [{
								"name": "gateway",
								"image": "IMAGE_PLACEHOLDER"
							}]
						}
					}
				}
			}`,
			namespace: "tenant-a",
			config: GatewayConfig{
				Image: "custom-registry/gateway:v1.0.0",
			},
			defaultImage: "ghcr.io/nvidia/openshell/gateway:0.0.71",
			checkField:   []string{"spec", "template", "spec", "containers"},
			wantValue:    "custom-registry/gateway:v1.0.0",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Create unstructured object from JSON
			manifest := &unstructured.Unstructured{}
			if err := manifest.UnmarshalJSON([]byte(tt.manifestJSON)); err != nil {
				t.Fatalf("failed to unmarshal test manifest: %v", err)
			}

			// Apply substitutions
			result, err := ApplyManifestToNamespace(manifest, tt.namespace, tt.config, tt.defaultImage)
			if err != nil {
				t.Fatalf("ApplyManifestToNamespace() error = %v", err)
			}

			// Verify the expected field was substituted
			if tt.checkField[len(tt.checkField)-1] == "namespace" {
				got := result.GetNamespace()
				if got != tt.wantValue {
					t.Errorf("ApplyManifestToNamespace() namespace = %v, want %v", got, tt.wantValue)
				}
			} else if tt.checkField[len(tt.checkField)-1] == "containers" {
				// Check container image
				containers, found, err := unstructured.NestedSlice(result.Object, tt.checkField...)
				if err != nil || !found || len(containers) == 0 {
					t.Fatalf("failed to get containers from result")
				}
				container := containers[0].(map[string]interface{})
				image, found, err := unstructured.NestedString(container, "image")
				if err != nil || !found {
					t.Fatalf("failed to get image from container")
				}
				if image != tt.wantValue {
					t.Errorf("ApplyManifestToNamespace() image = %v, want %v", image, tt.wantValue)
				}
			}
		})
	}
}
