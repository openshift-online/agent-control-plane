package applications_test

import (
	"flag"
	"os"
	"runtime"
	"testing"

	"github.com/golang/glog"

	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/test"

	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/agents"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/applications"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/credentials"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/inbox"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/projectSettings"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/projects"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/rbac"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/roleBindings"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/roles"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/sessions"
	_ "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/users"
	_ "github.com/openshift-online/rh-trex-ai/plugins/events"
	_ "github.com/openshift-online/rh-trex-ai/plugins/generic"
)

func TestMain(m *testing.M) {
	flag.Parse()
	glog.Infof("Starting applications integration test using go version %s", runtime.Version())
	helper := test.NewHelper(&testing.T{})
	exitCode := m.Run()
	helper.Teardown()
	os.Exit(exitCode)
}
