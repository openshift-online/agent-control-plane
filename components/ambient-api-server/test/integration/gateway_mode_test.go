package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
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

	// Create project
	proj := helper.CreateProject("test-proj")

	// Attempt to create agent - should fail with 403
	agent := openapi.Agent{
		Name:      "test-agent",
		ProjectId: proj.Id,
	}
	_, resp, err := helper.ApiClient.AgentsApi.CreateAgent(context.Background(), proj.Id).Agent(agent).Execute()
	require.Error(t, err)
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)

	// Verify error message mentions GitOps
	// Note: We can't easily check the response body with the current SDK,
	// but the 403 status confirms the gating is working

	// List agents - should succeed
	_, resp, err = helper.ApiClient.AgentsApi.ListAgents(context.Background(), proj.Id).Execute()
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	// Get agent (if any exist) - should succeed
	// We'll skip this since no agents exist

	// Cleanup
	os.Unsetenv("OPENSHELL_USE_GATEWAY")
	os.Unsetenv("OPENSHELL_ENABLED")
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
	resp, err := http.Get(helper.ApiServerURL() + "/api/ambient/v1/platform-info")
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var body struct {
		GatewayMode bool `json:"gateway_mode"`
	}
	err = json.NewDecoder(resp.Body).Decode(&body)
	require.NoError(t, err)
	assert.True(t, body.GatewayMode)

	// Cleanup
	os.Unsetenv("OPENSHELL_USE_GATEWAY")
	os.Unsetenv("OPENSHELL_ENABLED")
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

	// Create project
	proj := helper.CreateProject("test-proj-2")

	// Attempt to create agent - should succeed when gateway mode is off
	agent := openapi.Agent{
		Name:      "test-agent-2",
		ProjectId: proj.Id,
	}
	created, resp, err := helper.ApiClient.AgentsApi.CreateAgent(context.Background(), proj.Id).Agent(agent).Execute()
	require.NoError(t, err)
	assert.Equal(t, http.StatusCreated, resp.StatusCode)
	assert.NotNil(t, created)
	assert.Equal(t, "test-agent-2", *created.Name)

	// Platform-info should return gateway_mode: false
	infoResp, err := http.Get(helper.ApiServerURL() + "/api/ambient/v1/platform-info")
	require.NoError(t, err)
	defer infoResp.Body.Close()

	var body struct {
		GatewayMode bool `json:"gateway_mode"`
	}
	err = json.NewDecoder(infoResp.Body).Decode(&body)
	require.NoError(t, err)
	assert.False(t, body.GatewayMode)

	// Cleanup
	os.Unsetenv("OPENSHELL_USE_GATEWAY")
	os.Unsetenv("OPENSHELL_ENABLED")
}
