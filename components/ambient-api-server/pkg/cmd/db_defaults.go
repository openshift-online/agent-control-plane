package cmd

import "github.com/openshift-online/rh-trex-ai/pkg/config"

// setInPodDBDefaults overrides the upstream rh-trex-ai defaults to match the
// volume mount paths used by the API server deployment (/secrets/db/).
func setInPodDBDefaults(c *config.DatabaseConfig) {
	c.HostFile = "/secrets/db/db.host"
	c.PortFile = "/secrets/db/db.port"
	c.NameFile = "/secrets/db/db.name"
	c.UsernameFile = "/secrets/db/db.user"
	c.PasswordFile = "/secrets/db/db.password"
}
