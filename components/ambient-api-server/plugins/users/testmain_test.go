package users_test

import (
	"flag"
	"os"
	"runtime"
	"testing"

	"github.com/golang/glog"

	"github.com/ambient-code/platform/components/ambient-api-server/test"

	// Ensure all plugin migrations run in this test binary
	_ "github.com/ambient-code/platform/components/ambient-api-server/plugins/agents"
	_ "github.com/ambient-code/platform/components/ambient-api-server/plugins/credentials"
	_ "github.com/ambient-code/platform/components/ambient-api-server/plugins/inbox"
	_ "github.com/ambient-code/platform/components/ambient-api-server/plugins/projectSettings"
	_ "github.com/ambient-code/platform/components/ambient-api-server/plugins/projects"
	_ "github.com/ambient-code/platform/components/ambient-api-server/plugins/roleBindings"
	_ "github.com/ambient-code/platform/components/ambient-api-server/plugins/roles"
	_ "github.com/ambient-code/platform/components/ambient-api-server/plugins/scheduledSessions"
	_ "github.com/ambient-code/platform/components/ambient-api-server/plugins/sessions"
	_ "github.com/ambient-code/platform/components/ambient-api-server/plugins/users"
	_ "github.com/ambient-code/platform/components/ambient-api-server/plugins/version"
	_ "github.com/openshift-online/rh-trex-ai/plugins/events"
	_ "github.com/openshift-online/rh-trex-ai/plugins/generic"
)

func TestMain(m *testing.M) {
	flag.Parse()
	glog.Infof("Starting users integration test using go version %s", runtime.Version())
	helper := test.NewHelper(&testing.T{})
	exitCode := m.Run()
	helper.Teardown()
	os.Exit(exitCode)
}
