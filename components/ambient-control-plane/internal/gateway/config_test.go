package gateway

import (
	"testing"

	v1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestParseConfigMap(t *testing.T) {
	tests := []struct {
		name      string
		configMap *v1.ConfigMap
		wantCount int
	}{
		{
			name: "valid config with multiple namespaces",
			configMap: &v1.ConfigMap{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "platform-config",
					Namespace: "ambient-code",
				},
				Data: map[string]string{
					"namespaces": `- name: tenant-a
  gateway:
    image: ghcr.io/nvidia/openshell/gateway:0.0.74
    serverDnsNames:
      - openshell-gateway.tenant-a.svc.cluster.local
- name: tenant-b
  gateway:
    serverDnsNames:
      - openshell-gateway.tenant-b.svc.cluster.local`,
				},
			},
			wantCount: 2,
		},
		{
			name: "missing namespaces key",
			configMap: &v1.ConfigMap{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "platform-config",
					Namespace: "ambient-code",
				},
				Data: map[string]string{
					"other": "data",
				},
			},
			wantCount: 0,
		},
		{
			name: "malformed YAML",
			configMap: &v1.ConfigMap{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "platform-config",
					Namespace: "ambient-code",
				},
				Data: map[string]string{
					"namespaces": `invalid: yaml: [unclosed`,
				},
			},
			wantCount: 0,
		},
		{
			name: "empty namespaces",
			configMap: &v1.ConfigMap{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "platform-config",
					Namespace: "ambient-code",
				},
				Data: map[string]string{
					"namespaces": "[]",
				},
			},
			wantCount: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			configs := parseConfigMap(tt.configMap)
			if len(configs) != tt.wantCount {
				t.Errorf("parseConfigMap() returned %d configs, want %d", len(configs), tt.wantCount)
			}
		})
	}
}

func TestParseConfigMap_ValidConfig(t *testing.T) {
	cm := &v1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "platform-config",
			Namespace: "ambient-code",
		},
		Data: map[string]string{
			"namespaces": `- name: tenant-a
  gateway:
    image: ghcr.io/nvidia/openshell/gateway:0.0.74
    serverDnsNames:
      - openshell-gateway.tenant-a.svc.cluster.local
    config: |
      [openshell.gateway]
      bind_address = "0.0.0.0:8080"`,
		},
	}

	configs := parseConfigMap(cm)
	if len(configs) != 1 {
		t.Fatalf("expected 1 config, got %d", len(configs))
	}

	config := configs[0]
	if config.Name != "tenant-a" {
		t.Errorf("config.Name = %s, want tenant-a", config.Name)
	}
	if config.Gateway.Image != "ghcr.io/nvidia/openshell/gateway:0.0.74" {
		t.Errorf("config.Gateway.Image = %s, want ghcr.io/nvidia/openshell/gateway:0.0.74", config.Gateway.Image)
	}
	if len(config.Gateway.ServerDnsNames) != 1 {
		t.Fatalf("expected 1 ServerDnsName, got %d", len(config.Gateway.ServerDnsNames))
	}
	if config.Gateway.ServerDnsNames[0] != "openshell-gateway.tenant-a.svc.cluster.local" {
		t.Errorf("config.Gateway.ServerDnsNames[0] = %s, want openshell-gateway.tenant-a.svc.cluster.local", config.Gateway.ServerDnsNames[0])
	}
}
