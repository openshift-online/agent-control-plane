package client

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"

	"github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/types"
)

// RuntimeAPI is restricted to the configured control plane service identity.
// Its inventory includes deleted records until external resource cleanup ends.
type RuntimeAPI struct{ client *Client }

func (c *Client) Runtime() *RuntimeAPI { return &RuntimeAPI{client: c} }

func (a *RuntimeAPI) Projects(ctx context.Context, page, size int) (*types.ProjectList, error) {
	var result types.ProjectList
	err := a.client.do(ctx, http.MethodGet, fmt.Sprintf("/runtime/projects?page=%d&size=%d", page, size), nil, http.StatusOK, &result)
	return &result, err
}

func (a *RuntimeAPI) Sessions(ctx context.Context, page, size int) (*types.SessionList, error) {
	var result types.SessionList
	err := a.client.do(ctx, http.MethodGet, fmt.Sprintf("/runtime/sessions?page=%d&size=%d", page, size), nil, http.StatusOK, &result)
	return &result, err
}

// PatchProject changes only supplied runtime fields if version still matches.
func (a *RuntimeAPI) PatchProject(ctx context.Context, id string, version int, fields map[string]interface{}) (*types.Project, error) {
	var result types.Project
	err := a.patch(ctx, "projects", id, version, fields, &result)
	return &result, err
}

// PatchSession accepts expected_phase to protect a concurrent user stop or start.
func (a *RuntimeAPI) PatchSession(ctx context.Context, id string, version int, fields map[string]interface{}) (*types.Session, error) {
	var result types.Session
	err := a.patch(ctx, "sessions", id, version, fields, &result)
	return &result, err
}

func (a *RuntimeAPI) patch(ctx context.Context, resource, id string, version int, fields map[string]interface{}, result interface{}) error {
	patch := make(map[string]interface{})
	for key, value := range fields {
		patch[key] = value
	}
	patch["runtime_version"] = version
	body, err := json.Marshal(patch)
	if err != nil {
		return fmt.Errorf("encode runtime patch: %w", err)
	}
	return a.client.do(ctx, http.MethodPatch, "/runtime/"+resource+"/"+url.PathEscape(id), body, http.StatusOK, result)
}
