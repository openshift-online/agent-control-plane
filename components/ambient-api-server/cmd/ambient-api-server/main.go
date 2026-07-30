package main

import (
	"github.com/golang/glog"

	localapi "github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/api"
	localcmd "github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/cmd"
	pkgcmd "github.com/openshift-online/rh-trex-ai/pkg/cmd"

	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/cmd/ambient-api-server/environments"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/middleware"

	// Core plugins from upstream
	_ "github.com/openshift-online/rh-trex-ai/plugins/events"
	_ "github.com/openshift-online/rh-trex-ai/plugins/generic"

	// Backend-compatible plugins only
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/agents"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/applications"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/clusters"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/credentials"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/gateways"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/inbox"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/platformInfo"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/policies"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/projectSettings"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/projects"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/providers"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/proxy"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/rbac"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/roleBindings"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/roles"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/scheduledSessions"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/sessions"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/users"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/version"
)

func main() {
	rootCmd := pkgcmd.NewRootCommand("ambient-api-server", "Ambient API Server")
	rootCmd.AddCommand(
		pkgcmd.NewMigrateCommand("ambient-api-server"),
		pkgcmd.NewServeCommand(localapi.GetOpenAPISpec),
		localcmd.NewEncryptCredentialsCommand(),
		localcmd.NewSeedAdminCommand(),
	)

	if err := rootCmd.Execute(); err != nil {
		glog.Fatalf("error running command: %v", err)
	}
}
