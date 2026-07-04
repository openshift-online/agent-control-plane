package platformInfo

import (
	"encoding/json"
	"net/http"
	"strings"

	pkgserver "github.com/openshift-online/rh-trex-ai/pkg/server"
)

const platformInfoPath = "/api/ambient/v1/platform-info"

var responseBytes []byte

func init() {
	responseBytes, _ = json.Marshal(platformInfoResponse{
		GatewayMode: true,
	})

	// Pre-auth middleware — bypasses JWT validation, runs before RBAC
	pkgserver.RegisterPreAuthMiddleware(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet &&
				strings.TrimSuffix(r.URL.Path, "/") == platformInfoPath {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Cache-Control", "public, max-age=300") // 5 min
				_, _ = w.Write(responseBytes)
				return
			}
			next.ServeHTTP(w, r)
		})
	})
}

type platformInfoResponse struct {
	GatewayMode bool `json:"gateway_mode"`
}
