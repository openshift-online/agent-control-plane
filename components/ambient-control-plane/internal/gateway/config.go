package gateway

type NamespaceConfig struct {
	Name    string        `yaml:"name"`
	Gateway GatewayConfig `yaml:"gateway"`
}

type GatewayConfig struct {
	Image          string   `yaml:"image"`
	ServerDnsNames []string `yaml:"serverDnsNames"`
	Config         string   `yaml:"config"`
}
