package sessions

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

const managedRunnerBodyLimit = 16 << 20

// adaptManagedRunnerRequest translates the public file routes to the runner's
// content API. File paths stay in query values or JSON, never in routing fields.
func adaptManagedRunnerRequest(w http.ResponseWriter, req *http.Request, session *Session) bool {
	prefix := "/sandbox/" + *session.SandboxName + "/runner/" + session.ID
	suffix := strings.TrimPrefix(req.URL.Path, prefix)
	switch suffix {
	case "/agui/run":
		req.URL.Path = prefix + "/"
	case "/agui/interrupt", "/agui/feedback", "/agui/capabilities":
		req.URL.Path = prefix + strings.TrimPrefix(suffix, "/agui")
	case "/agui/tasks":
		req.URL.Path = prefix + "/tasks"
	case "/workspace", "/files":
		req.URL.Path = prefix + "/content/list"
	case "/git/status":
		req.URL.Path = prefix + "/content/git-status"
	case "/git/branches":
		req.URL.Path = prefix + "/content/git-list-branches"
	case "/git/configure-remote":
		req.URL.Path = prefix + "/content/git-configure-remote"
	default:
		var filePath string
		switch {
		case strings.HasPrefix(suffix, "/agui/tasks/"):
			req.URL.Path = prefix + strings.TrimPrefix(suffix, "/agui")
			req.URL.RawPath = ""
			return true
		case strings.HasPrefix(suffix, "/workspace/"):
			filePath = strings.TrimPrefix(suffix, "/workspace/")
		case strings.HasPrefix(suffix, "/files/"):
			filePath = strings.TrimPrefix(suffix, "/files/")
		default:
			return true
		}
		switch req.Method {
		case http.MethodGet:
			req.URL.Path = prefix + "/content/file"
			query := req.URL.Query()
			query.Set("path", filePath)
			req.URL.RawQuery = query.Encode()
		case http.MethodPut, http.MethodDelete:
			body := map[string]string{"path": filePath}
			if req.Method == http.MethodPut {
				data, err := io.ReadAll(http.MaxBytesReader(w, req.Body, managedRunnerBodyLimit))
				if err != nil {
					http.Error(w, "file request exceeds the size limit or cannot be read", http.StatusRequestEntityTooLarge)
					return false
				}
				if strings.HasPrefix(req.Header.Get("Content-Type"), "application/json") {
					if err := json.Unmarshal(data, &body); err != nil || body == nil {
						http.Error(w, "invalid file request", http.StatusBadRequest)
						return false
					}
					body["path"] = filePath
				} else {
					body["content"] = base64.StdEncoding.EncodeToString(data)
					body["encoding"] = "base64"
				}
				req.Method = http.MethodPost
				req.URL.Path = prefix + "/content/write"
			} else {
				req.URL.Path = prefix + "/content/delete"
			}
			data, err := json.Marshal(body)
			if err != nil {
				http.Error(w, "cannot encode file request", http.StatusInternalServerError)
				return false
			}
			req.Body = io.NopCloser(bytes.NewReader(data))
			req.ContentLength = int64(len(data))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Del("Content-Length")
		}
	}
	req.URL.RawPath = ""
	return true
}

// adaptManagedRunnerResponse preserves the public list envelopes. File reads
// remain byte streams and runner error responses retain their original status.
func adaptManagedRunnerResponse(w http.ResponseWriter, req *http.Request, resp *http.Response) bool {
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var key string
	switch {
	case strings.HasSuffix(req.URL.Path, "/content/list"):
		key = "items"
	case strings.HasSuffix(req.URL.Path, "/content/git-list-branches"):
		key = "branches"
	default:
		return false
	}
	var payload map[string]json.RawMessage
	if err := json.NewDecoder(io.LimitReader(resp.Body, managedRunnerBodyLimit)).Decode(&payload); err != nil {
		http.Error(w, "invalid runner response", http.StatusBadGateway)
		return true
	}
	value, ok := payload[key]
	if !ok || len(value) == 0 || value[0] != '[' {
		http.Error(w, "invalid runner list response", http.StatusBadGateway)
		return true
	}
	w.Header().Set("Content-Type", "application/json")
	if key == "items" {
		_ = json.NewEncoder(w).Encode(map[string]json.RawMessage{"files": value})
	} else {
		_, _ = w.Write(value)
	}
	return true
}

// runnerStreamWriter flushes each received event chunk to the caller.
type runnerStreamWriter struct{ http.ResponseWriter }

func (w runnerStreamWriter) Write(data []byte) (int, error) {
	n, err := w.ResponseWriter.Write(data)
	if err != nil {
		return n, err
	}
	if err := http.NewResponseController(w.ResponseWriter).Flush(); err != nil {
		return n, err
	}
	return n, nil
}
