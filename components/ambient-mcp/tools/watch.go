package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/ambient-code/platform/components/ambient-mcp/client"
)

var (
	subscriptionsMu sync.Mutex
	subscriptions   = make(map[string]context.CancelFunc)
)

func WatchSessionMessages(c *client.Client, transport string) func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if transport == "stdio" {
			return errResult("TRANSPORT_NOT_SUPPORTED", "watch_session_messages requires SSE transport; caller is on stdio"), nil
		}

		sessionID := mcp.ParseString(req, "session_id", "")
		if sessionID == "" {
			return errResult("INVALID_REQUEST", "session_id is required"), nil
		}

		afterSeq := int(mcp.ParseFloat64(req, "after_seq", 0))

		mcpServer := server.ServerFromContext(ctx)
		if mcpServer == nil {
			return errResult("INTERNAL_ERROR", "MCP server not available in context"), nil
		}

		clientSession := server.ClientSessionFromContext(ctx)
		if clientSession == nil {
			return errResult("INTERNAL_ERROR", "MCP client session not available in context"), nil
		}
		mcpSessionID := clientSession.SessionID()

		subID := fmt.Sprintf("sub_%s_%d", sessionID, time.Now().UnixNano())

		streamCtx, cancel := context.WithCancel(ctx)

		subscriptionsMu.Lock()
		subscriptions[subID] = cancel
		subscriptionsMu.Unlock()

		go streamMessages(streamCtx, c, mcpServer, mcpSessionID, sessionID, subID, afterSeq)

		return jsonResult(map[string]interface{}{
			"subscription_id": subID,
			"session_id":      sessionID,
			"note":            "streaming subscription registered; messages delivered via notifications/progress",
		})
	}
}

func streamMessages(ctx context.Context, c *client.Client, mcpServer *server.MCPServer, mcpSessionID, sessionID, subID string, afterSeq int) {
	defer func() {
		subscriptionsMu.Lock()
		delete(subscriptions, subID)
		subscriptionsMu.Unlock()
	}()

	path := fmt.Sprintf("/sessions/%s/messages?after_seq=%d", sessionID, afterSeq)
	events, errs := c.StreamSSE(ctx, path)

	phaseTicker := time.NewTicker(5 * time.Second)
	defer phaseTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return

		case evt, ok := <-events:
			if !ok {
				return
			}
			var msgPayload interface{}
			if err := json.Unmarshal([]byte(evt.Data), &msgPayload); err != nil {
				msgPayload = evt.Data
			}
			_ = mcpServer.SendNotificationToSpecificClient(mcpSessionID, "notifications/progress", map[string]any{
				"progressToken": subID,
				"progress": map[string]any{
					"session_id": sessionID,
					"message":    msgPayload,
				},
			})

		case err, ok := <-errs:
			if ok && err != nil {
				_ = mcpServer.SendNotificationToSpecificClient(mcpSessionID, "notifications/progress", map[string]any{
					"progressToken": subID,
					"progress": map[string]any{
						"session_id": sessionID,
						"terminal":   true,
						"error":      err.Error(),
					},
				})
			}
			return

		case <-phaseTicker.C:
			var session struct {
				Phase string `json:"phase"`
			}
			if err := c.Get(ctx, "/sessions/"+sessionID, &session); err != nil {
				continue
			}
			if session.Phase == "Completed" || session.Phase == "Failed" || session.Phase == "Stopped" {
				_ = mcpServer.SendNotificationToSpecificClient(mcpSessionID, "notifications/progress", map[string]any{
					"progressToken": subID,
					"progress": map[string]any{
						"session_id": sessionID,
						"terminal":   true,
						"phase":      session.Phase,
					},
				})
				return
			}
		}
	}
}

func UnwatchSessionMessages() func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		subID := mcp.ParseString(req, "subscription_id", "")
		if subID == "" {
			return errResult("INVALID_REQUEST", "subscription_id is required"), nil
		}

		subscriptionsMu.Lock()
		cancel, ok := subscriptions[subID]
		if ok {
			cancel()
			delete(subscriptions, subID)
		}
		subscriptionsMu.Unlock()

		if !ok {
			return errResult("SUBSCRIPTION_NOT_FOUND", "no active subscription with id "+subID), nil
		}
		return jsonResult(map[string]interface{}{"cancelled": true})
	}
}
