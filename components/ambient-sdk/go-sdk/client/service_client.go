package client

import (
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

func NewServiceClient(baseURL, token string, opts ...ClientOption) (*Client, error) {
	if token == "" {
		return nil, fmt.Errorf("token is required")
	}

	if len(token) < 20 {
		return nil, fmt.Errorf("token is too short (minimum 20 characters)")
	}

	if token == "YOUR_TOKEN_HERE" || token == "PLACEHOLDER_TOKEN" {
		return nil, fmt.Errorf("placeholder token is not allowed")
	}

	if err := validateURL(baseURL); err != nil {
		return nil, fmt.Errorf("invalid base URL: %w", err)
	}

	streamingTransport := http.DefaultTransport.(*http.Transport).Clone()
	streamingTransport.DisableCompression = true

	c := &Client{
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		streamingClient: &http.Client{Transport: streamingTransport},
		baseURL:         strings.TrimSuffix(baseURL, "/"),
		token:           token,
		project:         "",
		logger:          slog.Default(),
		userAgent:       "ambient-go-sdk/1.0.0",
	}

	for _, opt := range opts {
		opt(c)
	}

	c.logger = c.logger.With(slog.String("sdk", "go"), slog.String("scope", "global"))

	return c, nil
}
