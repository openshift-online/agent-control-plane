package cmd

import (
	"testing"

	"github.com/openshift-online/rh-trex-ai/pkg/config"
)

func TestSetInPodDBDefaults(t *testing.T) {
	tests := []struct {
		name  string
		field func(*config.DatabaseConfig) string
		want  string
	}{
		{"HostFile", func(c *config.DatabaseConfig) string { return c.HostFile }, "/secrets/db/db.host"},
		{"PortFile", func(c *config.DatabaseConfig) string { return c.PortFile }, "/secrets/db/db.port"},
		{"NameFile", func(c *config.DatabaseConfig) string { return c.NameFile }, "/secrets/db/db.name"},
		{"UsernameFile", func(c *config.DatabaseConfig) string { return c.UsernameFile }, "/secrets/db/db.user"},
		{"PasswordFile", func(c *config.DatabaseConfig) string { return c.PasswordFile }, "/secrets/db/db.password"},
	}

	c := config.NewDatabaseConfig()
	setInPodDBDefaults(c)

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.field(c); got != tt.want {
				t.Errorf("setInPodDBDefaults() %s = %q, want %q", tt.name, got, tt.want)
			}
		})
	}
}
