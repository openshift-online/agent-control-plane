package gateway

import (
	"strings"
	"testing"
)

func TestValidateDNSName(t *testing.T) {
	tests := []struct {
		name    string
		dnsName string
		wantErr bool
	}{
		{
			name:    "valid simple DNS name",
			dnsName: "openshell-gateway.tenant-a.svc.cluster.local",
			wantErr: false,
		},
		{
			name:    "valid short DNS name",
			dnsName: "localhost",
			wantErr: false,
		},
		{
			name:    "empty DNS name",
			dnsName: "",
			wantErr: true,
		},
		{
			name:    "DNS name too long",
			dnsName: strings.Repeat("a", 254),
			wantErr: true,
		},
		{
			name:    "DNS name with uppercase",
			dnsName: "Gateway.Example.COM",
			wantErr: true,
		},
		{
			name:    "DNS name with underscore",
			dnsName: "gateway_name.example.com",
			wantErr: true,
		},
		{
			name:    "DNS name with spaces",
			dnsName: "gateway name.example.com",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateDNSName(tt.dnsName)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateDNSName() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestValidateImageReference(t *testing.T) {
	tests := []struct {
		name    string
		image   string
		wantErr bool
	}{
		{
			name:    "valid image with tag",
			image:   "ghcr.io/nvidia/openshell/gateway:0.0.71",
			wantErr: false,
		},
		{
			name:    "valid image with digest",
			image:   "gcr.io/repo/image@sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
			wantErr: false,
		},
		{
			name:    "valid short image",
			image:   "nginx:latest",
			wantErr: false,
		},
		{
			name:    "empty image",
			image:   "",
			wantErr: true,
		},
		{
			name:    "image with semicolon injection",
			image:   "nginx:latest; rm -rf /",
			wantErr: true,
		},
		{
			name:    "image with pipe injection",
			image:   "nginx:latest | cat /etc/passwd",
			wantErr: true,
		},
		{
			name:    "image with backtick injection",
			image:   "nginx:latest`whoami`",
			wantErr: true,
		},
		{
			name:    "image with dollar sign",
			image:   "nginx:$TAG",
			wantErr: true,
		},
		{
			name:    "image with newline",
			image:   "nginx:latest\nmalicious",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateImageReference(tt.image)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateImageReference() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestValidateGatewayConfig(t *testing.T) {
	tests := []struct {
		name    string
		config  GatewayConfig
		wantErr bool
	}{
		{
			name: "valid config with all fields",
			config: GatewayConfig{
				Image:          "ghcr.io/nvidia/openshell/gateway:0.0.71",
				ServerDnsNames: []string{"openshell-gateway.tenant-a.svc.cluster.local"},
				Config:         "[openshell.gateway]\nbind_address = \"0.0.0.0:8080\"",
			},
			wantErr: false,
		},
		{
			name: "valid config without image",
			config: GatewayConfig{
				ServerDnsNames: []string{"gateway.example.com"},
			},
			wantErr: false,
		},
		{
			name: "missing serverDnsNames",
			config: GatewayConfig{
				Image: "nginx:latest",
			},
			wantErr: true,
		},
		{
			name: "invalid image reference",
			config: GatewayConfig{
				Image:          "nginx; rm -rf /",
				ServerDnsNames: []string{"gateway.example.com"},
			},
			wantErr: true,
		},
		{
			name: "invalid DNS name",
			config: GatewayConfig{
				ServerDnsNames: []string{"Gateway_Invalid"},
			},
			wantErr: true,
		},
		{
			name: "config with null bytes",
			config: GatewayConfig{
				ServerDnsNames: []string{"gateway.example.com"},
				Config:         "config\x00injection",
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateGatewayConfig(tt.config)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateGatewayConfig() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
