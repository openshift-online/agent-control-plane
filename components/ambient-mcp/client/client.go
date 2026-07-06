package client

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type Client struct {
	httpClient *http.Client
	baseURL    string
	mu         sync.RWMutex
	token      string
}

func New(baseURL, token string) *Client {
	return &Client{
		httpClient: &http.Client{Timeout: 30 * time.Second},
		baseURL:    strings.TrimSuffix(baseURL, "/"),
		token:      token,
	}
}

func (c *Client) BaseURL() string { return c.baseURL }

func (c *Client) Token() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.token
}

func (c *Client) SetToken(token string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.token = token
}

func (c *Client) do(ctx context.Context, method, path string, body []byte, result interface{}, expectedStatuses ...int) error {
	reqURL := c.baseURL + "/api/ambient/v1" + path
	var bodyReader io.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, reqURL, bodyReader)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+c.Token())
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}

	ok := false
	for _, s := range expectedStatuses {
		if resp.StatusCode == s {
			ok = true
			break
		}
	}
	if !ok {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	if result != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, result); err != nil {
			return fmt.Errorf("unmarshal response: %w", err)
		}
	}
	return nil
}

func (c *Client) Get(ctx context.Context, path string, result interface{}) error {
	return c.do(ctx, http.MethodGet, path, nil, result, http.StatusOK)
}

func (c *Client) GetWithQuery(ctx context.Context, path string, params url.Values, result interface{}) error {
	if len(params) > 0 {
		path = path + "?" + params.Encode()
	}
	return c.Get(ctx, path, result)
}

func (c *Client) Post(ctx context.Context, path string, body interface{}, result interface{}, expectedStatus int) error {
	b, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal body: %w", err)
	}
	return c.do(ctx, http.MethodPost, path, b, result, expectedStatus)
}

func (c *Client) Patch(ctx context.Context, path string, body interface{}, result interface{}) error {
	b, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal body: %w", err)
	}
	return c.do(ctx, http.MethodPatch, path, b, result, http.StatusOK)
}

type SSEEvent struct {
	ID   string
	Data string
}

func (c *Client) StreamSSE(ctx context.Context, path string) (<-chan SSEEvent, <-chan error) {
	events := make(chan SSEEvent, 64)
	errs := make(chan error, 1)

	go func() {
		defer close(events)
		defer close(errs)

		reqURL := c.baseURL + "/api/ambient/v1" + path
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
		if err != nil {
			errs <- fmt.Errorf("create request: %w", err)
			return
		}
		req.Header.Set("Authorization", "Bearer "+c.Token())
		req.Header.Set("Accept", "text/event-stream")

		sseClient := &http.Client{Transport: c.httpClient.Transport}
		resp, err := sseClient.Do(req)
		if err != nil {
			errs <- fmt.Errorf("SSE connect failed: %w", err)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			errs <- fmt.Errorf("SSE HTTP %d: %s", resp.StatusCode, string(body))
			return
		}

		scanner := bufio.NewScanner(resp.Body)
		var currentID string
		var dataLines []string

		for scanner.Scan() {
			line := scanner.Text()

			if line == "" {
				if len(dataLines) > 0 {
					data := strings.Join(dataLines, "\n")
					select {
					case events <- SSEEvent{ID: currentID, Data: data}:
					case <-ctx.Done():
						return
					}
					currentID = ""
					dataLines = nil
				}
				continue
			}

			if strings.HasPrefix(line, "data:") {
				dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
			} else if strings.HasPrefix(line, "id:") {
				currentID = strings.TrimSpace(strings.TrimPrefix(line, "id:"))
			}
		}

		if err := scanner.Err(); err != nil {
			if ctx.Err() == nil {
				errs <- fmt.Errorf("SSE stream read: %w", err)
			}
		}
	}()

	return events, errs
}
