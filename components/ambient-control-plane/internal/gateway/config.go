package gateway

type NamespaceConfig struct {
	Name    string        `yaml:"name"`
	Gateway GatewayConfig `yaml:"gateway"`
}

type OidcConfig struct {
	Issuer      string `yaml:"issuer" json:"issuer,omitempty"`
	Audience    string `yaml:"audience" json:"audience,omitempty"`
	JwksTtl     int    `yaml:"jwks_ttl" json:"jwks_ttl,omitempty"`
	RolesClaim  string `yaml:"roles_claim" json:"roles_claim,omitempty"`
	AdminRole   string `yaml:"admin_role" json:"admin_role,omitempty"`
	UserRole    string `yaml:"user_role" json:"user_role,omitempty"`
	ScopesClaim string `yaml:"scopes_claim" json:"scopes_claim,omitempty"`
}

type GatewayConfig struct {
	Image          string      `yaml:"image"`
	ServerDnsNames []string    `yaml:"serverDnsNames"`
	Config         string      `yaml:"config"`
	Oidc           *OidcConfig `yaml:"oidc,omitempty"`
}
