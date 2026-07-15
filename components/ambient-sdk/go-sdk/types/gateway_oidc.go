package types

type GatewayOidc struct {
	Issuer      string `json:"issuer,omitempty"`
	Audience    string `json:"audience,omitempty"`
	JwksTtl     int    `json:"jwks_ttl,omitempty"`
	RolesClaim  string `json:"roles_claim,omitempty"`
	AdminRole   string `json:"admin_role,omitempty"`
	UserRole    string `json:"user_role,omitempty"`
	ScopesClaim string `json:"scopes_claim,omitempty"`
}
