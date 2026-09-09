package client

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// CheckRunnerAccess checks the caller's session permission without changing state.
// action is empty for method-based access, or "stop" for a POST task stop.
func (a *SessionAPI) CheckRunnerAccess(ctx context.Context, id, method, action string) error {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return fmt.Errorf("unsupported runner access method")
	}
	suffix := ""
	if action != "" {
		if action != "stop" || method != http.MethodPost {
			return fmt.Errorf("unsupported runner access action")
		}
		suffix = "/stop"
	}
	return a.client.do(ctx, method, "/sessions/"+url.PathEscape(id)+"/runner/access"+suffix, nil, http.StatusNoContent, nil)
}
