package gateway

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	// DNS label validation per RFC 1123
	dnsLabelRegex = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`)

	// Image reference validation (basic format: registry/repo:tag or repo:tag)
	imageRefRegex = regexp.MustCompile(`^([a-z0-9.-]+/)?[a-z0-9._-]+(/[a-z0-9._-]+)*(:[a-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$`)
)

// ValidateDNSName validates a DNS name per RFC 1123
func ValidateDNSName(name string) error {
	if len(name) == 0 {
		return fmt.Errorf("DNS name cannot be empty")
	}
	if len(name) > 253 {
		return fmt.Errorf("DNS name too long (max 253 characters): %d", len(name))
	}
	if !dnsLabelRegex.MatchString(name) {
		return fmt.Errorf("invalid DNS name format: %q", name)
	}
	return nil
}

// ValidateImageReference validates a container image reference
func ValidateImageReference(ref string) error {
	if len(ref) == 0 {
		return fmt.Errorf("image reference cannot be empty")
	}

	// Normalize to lowercase for validation
	normalized := strings.ToLower(ref)

	if !imageRefRegex.MatchString(normalized) {
		return fmt.Errorf("invalid image reference format: %q", ref)
	}

	// Reject obvious injection attempts
	if strings.Contains(ref, ";") || strings.Contains(ref, "&") ||
		strings.Contains(ref, "|") || strings.Contains(ref, "`") ||
		strings.Contains(ref, "$") || strings.Contains(ref, "\n") {
		return fmt.Errorf("image reference contains invalid characters: %q", ref)
	}

	return nil
}

// ValidateGatewayConfig validates all user-controlled fields in GatewayConfig
func ValidateGatewayConfig(config GatewayConfig) error {
	// Validate image reference if provided
	if config.Image != "" {
		if err := ValidateImageReference(config.Image); err != nil {
			return fmt.Errorf("invalid image: %w", err)
		}
	}

	// Validate DNS names (required)
	if len(config.ServerDnsNames) == 0 {
		return fmt.Errorf("serverDnsNames is required")
	}

	for i, dns := range config.ServerDnsNames {
		if err := ValidateDNSName(dns); err != nil {
			return fmt.Errorf("invalid serverDnsNames[%d]: %w", i, err)
		}
	}

	// Config (TOML) is validated by the gateway itself at runtime, but check for basic injection
	if strings.Contains(config.Config, "\x00") {
		return fmt.Errorf("config contains null bytes")
	}

	return nil
}
