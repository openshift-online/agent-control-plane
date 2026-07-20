package types

type GatewayDatabase struct {
	Type              string `json:"type"`
	StorageSize       string `json:"storage_size,omitempty"`
	Image             string `json:"image,omitempty"`
	ExternalSecretRef string `json:"external_secret_ref,omitempty"`
}
