package inbox_test

import (
	"os"
	"testing"
)

// All inbox integration tests are currently skipped (pending nested route
// client update). Skipping the full test infrastructure avoids a race
// between the gRPC Serve goroutine and GracefulStop during teardown that
// causes os.Exit(1) via rh-trex-ai's Check(). Re-add the server setup
// when the integration tests are re-enabled.
func TestMain(m *testing.M) {
	os.Exit(m.Run())
}
