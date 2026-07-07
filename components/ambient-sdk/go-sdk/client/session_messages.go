package client

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
)

const (
	sseInitialBackoff = 1 * time.Second
	sseMaxBackoff     = 30 * time.Second
	sseScannerBufSize = 1 << 20
)

func (a *SessionAPI) PushMessage(ctx context.Context, sessionID, payload string) (*types.SessionMessage, error) {
	push := struct {
		EventType string `json:"event_type"`
		Payload   string `json:"payload"`
	}{EventType: "user", Payload: payload}
	body, err := json.Marshal(push)
	if err != nil {
		return nil, fmt.Errorf("marshal message: %w", err)
	}
	var result types.SessionMessage
	if err := a.client.do(ctx, http.MethodPost, "/sessions/"+url.PathEscape(sessionID)+"/messages", body, http.StatusCreated, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (a *SessionAPI) ListMessages(ctx context.Context, sessionID string, afterSeq int) ([]types.SessionMessage, error) {
	path := fmt.Sprintf("/sessions/%s/messages?after_seq=%d", url.PathEscape(sessionID), afterSeq)
	var result []types.SessionMessage
	if err := a.client.do(ctx, http.MethodGet, path, nil, http.StatusOK, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// WatchMessages streams session messages from afterSeq onward via SSE.
// Returns a channel of messages, a stop function, and any immediate connection error.
// Call stop() to cancel the stream and release resources.
func (a *SessionAPI) WatchMessages(ctx context.Context, sessionID string, afterSeq int) (<-chan *types.SessionMessage, func(), error) {
	watchCtx, cancel := context.WithCancel(ctx)
	msgs := make(chan *types.SessionMessage, 64)

	go func() {
		defer close(msgs)

		lastSeq := afterSeq
		backoff := sseInitialBackoff

		for {
			if watchCtx.Err() != nil {
				return
			}

			plain := make(chan types.SessionMessage, 64)
			done := make(chan struct{})
			go func() {
				defer close(done)
				for m := range plain {
					mc := m
					select {
					case msgs <- &mc:
					case <-watchCtx.Done():
						return
					}
				}
			}()

			err := a.consumeSSE(watchCtx, sessionID, "messages", lastSeq, plain, func(seq int) {
				lastSeq = seq
			})
			close(plain)
			<-done

			if watchCtx.Err() != nil {
				return
			}

			if err != nil {
				a.client.logger.Debug("sse stream error, will reconnect",
					"session_id", sessionID,
					"after_seq", lastSeq,
					"backoff", backoff,
					"err", err,
				)
			}

			select {
			case <-watchCtx.Done():
				return
			case <-time.After(backoff):
			}

			backoff *= 2
			if backoff > sseMaxBackoff {
				backoff = sseMaxBackoff
			}
		}
	}()

	return msgs, cancel, nil
}

func (a *SessionAPI) consumeSSE(
	ctx context.Context,
	sessionID, endpoint string,
	afterSeq int,
	msgs chan<- types.SessionMessage,
	onMsg func(seq int),
) error {
	parsed, err := url.Parse(a.client.baseURL)
	if err != nil {
		return fmt.Errorf("parse base url: %w", err)
	}

	host := parsed.Hostname()
	port := parsed.Port()
	if port == "" {
		if parsed.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}

	path := fmt.Sprintf("/api/ambient/v1/sessions/%s/%s?after_seq=%d",
		url.PathEscape(sessionID),
		endpoint,
		afterSeq,
	)

	var conn net.Conn
	dialer := &net.Dialer{Timeout: 30 * time.Second}
	if parsed.Scheme == "https" {
		tlsConf := &tls.Config{MinVersion: tls.VersionTLS12}
		if a.client.insecureSkipVerify {
			tlsConf.InsecureSkipVerify = true //nolint:gosec
		}
		conn, err = tls.DialWithDialer(&net.Dialer{Timeout: 30 * time.Second}, "tcp", net.JoinHostPort(host, port), tlsConf)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", net.JoinHostPort(host, port))
	}
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close() //nolint:errcheck

	go func() {
		<-ctx.Done()
		conn.Close() //nolint:errcheck
	}()

	var reqBuf strings.Builder
	fmt.Fprintf(&reqBuf, "GET %s HTTP/1.1\r\n", path)
	fmt.Fprintf(&reqBuf, "Host: %s\r\n", parsed.Host)
	reqBuf.WriteString("Accept: text/event-stream\r\n")
	reqBuf.WriteString("Cache-Control: no-cache\r\n")
	reqBuf.WriteString("Connection: close\r\n")
	if a.client.token != "" {
		fmt.Fprintf(&reqBuf, "Authorization: Bearer %s\r\n", a.client.token)
	}
	if a.client.project != "" {
		fmt.Fprintf(&reqBuf, "X-Ambient-Project: %s\r\n", a.client.project)
	}
	reqBuf.WriteString("\r\n")

	if _, err := conn.Write([]byte(reqBuf.String())); err != nil {
		return fmt.Errorf("write request: %w", err)
	}

	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, sseScannerBufSize), sseScannerBufSize)

	headersDone := false
	var dataBuf strings.Builder

	for scanner.Scan() {
		if ctx.Err() != nil {
			return nil
		}

		line := scanner.Text()

		if !headersDone {
			if line == "" || line == "\r" {
				headersDone = true
			}
			continue
		}

		switch {
		case strings.HasPrefix(line, "data: "):
			if dataBuf.Len() > 0 {
				dataBuf.WriteByte('\n')
			}
			dataBuf.WriteString(line[6:])

		case line == "" || line == "\r":
			if dataBuf.Len() == 0 {
				continue
			}
			data := dataBuf.String()
			dataBuf.Reset()

			var msg types.SessionMessage
			if err := json.Unmarshal([]byte(data), &msg); err != nil {
				continue
			}

			select {
			case msgs <- msg:
				onMsg(msg.Seq)
			case <-ctx.Done():
				return nil
			}
		}
	}

	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return fmt.Errorf("scanner: %w", err)
	}
	return nil
}

func (a *SessionAPI) StreamEvents(ctx context.Context, sessionID string) (io.ReadCloser, error) {
	rawURL := a.client.baseURL + "/api/ambient/v1/sessions/" + url.PathEscape(sessionID) + "/events"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Authorization", "Bearer "+a.client.token)
	req.Header.Set("X-Ambient-Project", a.client.project)

	resp, err := a.client.streamingClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("connect to event stream: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		return nil, fmt.Errorf("server returned %s", resp.Status)
	}
	return resp.Body, nil
}
