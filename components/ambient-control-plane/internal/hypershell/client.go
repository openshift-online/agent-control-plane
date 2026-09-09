// Package hypershell defines the resource API boundary used by the managed runtime.
package hypershell

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type TokenProvider interface {
	Token(context.Context) (string, error)
}

type Gateway struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	ExternalReference string `json:"external_reference"`
	Namespace         string `json:"namespace"`
	Phase             string `json:"phase"`
	Status            string `json:"status"`
	RouteAddress      string `json:"route_address"`
	OIDC              string `json:"oidc"`
}

type Connection struct {
	GatewayEndpoint string `json:"gateway_endpoint"`
	TokenEndpoint   string `json:"token_endpoint"`
	ClientID        string `json:"client_id"`
	ClientSecret    string `json:"client_secret,omitempty"`
	Audience        string `json:"audience"`
}

type ServiceAccount struct {
	ID         string     `json:"id"`
	GatewayID  string     `json:"gateway_id"`
	Name       string     `json:"name"`
	Status     string     `json:"status"`
	ExpiresAt  time.Time  `json:"expires_at"`
	Credential Connection `json:"credential"`
	Connection Connection `json:"connection"`
}

type DeletionStatus struct {
	GatewayID           string     `json:"gateway_id"`
	ExternalReference   string     `json:"external_reference"`
	State               string     `json:"state"`
	DeletionCompletedAt *time.Time `json:"deletion_completed_at"`
}

func (c *Client) GatewayDeletion(ctx context.Context, reference string) (*DeletionStatus, error) {
	var result DeletionStatus
	err := c.request(ctx, http.MethodGet, "/gateways/deletion?external_reference="+url.QueryEscape(reference), nil, &result, http.StatusOK)
	return &result, err
}

// APIError excludes response bodies because a resource response can contain credentials.
type APIError struct {
	Status    int
	Operation string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("Hypershell %s returned HTTP %d", e.Operation, e.Status)
}
func IsNotFound(err error) bool {
	var e *APIError
	return errors.As(err, &e) && e.Status == http.StatusNotFound
}

type Client struct {
	base  string
	token TokenProvider
	http  *http.Client
}

func NewClient(base string, token TokenProvider, httpClient *http.Client) (*Client, error) {
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("hypershell API URL must use HTTPS without credentials, query, or fragment")
	}
	if token == nil {
		return nil, fmt.Errorf("hypershell token provider is required")
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 45 * time.Second}
	}
	copyClient := *httpClient
	// Never forward management credentials to a redirect target.
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{base: strings.TrimSuffix(strings.TrimRight(base, "/"), "/api/hypershell/v1") + "/api/hypershell/v1", token: token, http: &copyClient}, nil
}

func (c *Client) request(ctx context.Context, method, path string, body interface{}, out interface{}, accepted ...int) (resultErr error) {
	var encoded []byte
	var err error
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode Hypershell request: %w", err)
		}
	}
	token, err := c.token.Token(ctx)
	if err != nil {
		return fmt.Errorf("obtain Hypershell token: %w", err)
	}
	if token == "" {
		return fmt.Errorf("hypershell token is empty")
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, bytes.NewReader(encoded))
	if err != nil {
		return fmt.Errorf("create Hypershell request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("send Hypershell request: %w", err)
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("close Hypershell response: %w", err))
		}
	}()
	valid := false
	for _, code := range accepted {
		if resp.StatusCode == code {
			valid = true
			break
		}
	}
	if !valid {
		return &APIError{Status: resp.StatusCode, Operation: method + " " + strings.Split(path, "?")[0]}
	}
	if out != nil && resp.StatusCode != http.StatusNoContent {
		if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out); err != nil {
			return fmt.Errorf("decode Hypershell response: %w", err)
		}
	}
	return nil
}

func (c *Client) CreateGateway(ctx context.Context, name, reference string, template map[string]interface{}) (*Gateway, error) {
	body := make(map[string]interface{}, len(template)+2)
	for k, v := range template {
		body[k] = v
	}
	body["name"], body["external_reference"] = name, reference
	var result Gateway
	err := c.request(ctx, http.MethodPost, "/gateways", body, &result, http.StatusCreated)
	return &result, err
}
func (c *Client) GetGateway(ctx context.Context, id string) (*Gateway, error) {
	var result Gateway
	err := c.request(ctx, http.MethodGet, "/gateways/"+url.PathEscape(id), nil, &result, http.StatusOK)
	return &result, err
}
func (c *Client) FindGateway(ctx context.Context, reference string) (*Gateway, error) {
	var result struct {
		Items []Gateway `json:"items"`
	}
	if err := c.request(ctx, http.MethodGet, "/gateways?external_reference="+url.QueryEscape(reference), nil, &result, http.StatusOK); err != nil {
		return nil, err
	}
	if len(result.Items) == 0 {
		return nil, nil
	}
	if len(result.Items) != 1 {
		return nil, fmt.Errorf("hypershell reference is not unique")
	}
	return &result.Items[0], nil
}
func (c *Client) DeleteGateway(ctx context.Context, id string) error {
	err := c.request(ctx, http.MethodDelete, "/gateways/"+url.PathEscape(id), nil, nil, http.StatusNoContent, http.StatusAccepted)
	if IsNotFound(err) {
		return nil
	}
	return err
}
func accountPath(gatewayID string) string {
	return "/gateways/" + url.PathEscape(gatewayID) + "/service_accounts"
}
func (c *Client) CreateAccount(ctx context.Context, gatewayID, name string) (*ServiceAccount, error) {
	var result ServiceAccount
	body := map[string]interface{}{"name": name, "credential_type": "client_secret", "role": "openshell-admin"}
	err := c.request(ctx, http.MethodPost, accountPath(gatewayID), body, &result, http.StatusCreated)
	return &result, err
}
func (c *Client) ListAccounts(ctx context.Context, gatewayID string) ([]ServiceAccount, error) {
	var items []ServiceAccount
	for page := 1; ; page++ {
		var result struct {
			Items []ServiceAccount `json:"items"`
			Total int              `json:"total"`
		}
		if err := c.request(ctx, http.MethodGet, fmt.Sprintf("%s?page=%d&size=100", accountPath(gatewayID), page), nil, &result, http.StatusOK); err != nil {
			return nil, err
		}
		items = append(items, result.Items...)
		if page*100 >= result.Total {
			return items, nil
		}
	}
}
func (c *Client) GetAccount(ctx context.Context, gatewayID, id string) (*ServiceAccount, error) {
	var result ServiceAccount
	err := c.request(ctx, http.MethodGet, accountPath(gatewayID)+"/"+url.PathEscape(id), nil, &result, http.StatusOK)
	return &result, err
}

// RevokeAccount returns false while the identity provider is still converging.
func (c *Client) RevokeAccount(ctx context.Context, gatewayID, id string) (bool, error) {
	var result ServiceAccount
	err := c.request(ctx, http.MethodPost, accountPath(gatewayID)+"/"+url.PathEscape(id)+"/revoke", nil, &result, http.StatusOK, http.StatusAccepted)
	if IsNotFound(err) {
		return true, nil
	}
	return result.Status == "revoked", err
}
