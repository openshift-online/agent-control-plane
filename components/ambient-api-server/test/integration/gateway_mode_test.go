package integration

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"testing"

	"github.com/ambient-code/platform/components/ambient-api-server/test"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGatewayMode_AgentCRUDGating(t *testing.T) {
	// Set gateway mode flags
	os.Setenv("OPENSHELL_USE_GATEWAY", "true")
	os.Setenv("OPENSHELL_ENABLED", "true")
	defer func() {
		os.Unsetenv("OPENSHELL_USE_GATEWAY")
		os.Unsetenv("OPENSHELL_ENABLED")
	}()

	helper := test.NewHelper(t)

	// Use a test project ID (the gating check happens before DB lookup)
	testProjectID := "test-project-id"

	// Attempt to create agent - should fail with 403 due to gateway mode gating
	agentJSON := []byte(`{"name":"test-agent","project_id":"test-project-id"}`)
	req, _ := http.NewRequest("POST", helper.RestURL("/projects/"+testProjectID+"/agents"), bytes.NewBuffer(agentJSON))
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)

	// List agents - should succeed (read operations not gated)
	resp, err = http.Get(helper.RestURL("/projects/" + testProjectID + "/agents"))
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

func TestGatewayMode_PlatformInfoEndpoint(t *testing.T) {
	// Set gateway mode flags
	os.Setenv("OPENSHELL_USE_GATEWAY", "true")
	os.Setenv("OPENSHELL_ENABLED", "true")
	defer func() {
		os.Unsetenv("OPENSHELL_USE_GATEWAY")
		os.Unsetenv("OPENSHELL_ENABLED")
	}()

	helper := test.NewHelper(t)

	// Call platform-info endpoint
	resp, err := http.Get(helper.RestURL("/platform-info"))
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var body struct {
		GatewayMode bool `json:"gateway_mode"`
	}
	err = json.NewDecoder(resp.Body).Decode(&body)
	require.NoError(t, err)
	assert.True(t, body.GatewayMode)
}

func TestGatewayMode_Disabled(t *testing.T) {
	// Ensure gateway mode is disabled
	os.Setenv("OPENSHELL_USE_GATEWAY", "false")
	os.Setenv("OPENSHELL_ENABLED", "false")
	defer func() {
		os.Unsetenv("OPENSHELL_USE_GATEWAY")
		os.Unsetenv("OPENSHELL_ENABLED")
	}()

	helper := test.NewHelper(t)

	// Platform-info should return gateway_mode: false
	infoResp, err := http.Get(helper.RestURL("/platform-info"))
	require.NoError(t, err)
	defer infoResp.Body.Close()

	var body struct {
		GatewayMode bool `json:"gateway_mode"`
	}
	err = json.NewDecoder(infoResp.Body).Decode(&body)
	require.NoError(t, err)
	assert.False(t, body.GatewayMode)

	// Note: We skip testing agent creation when gateway mode is off
	// because it requires database setup and is covered by existing agent tests
}
