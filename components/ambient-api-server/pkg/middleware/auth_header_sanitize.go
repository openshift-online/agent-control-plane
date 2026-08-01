package middleware

import (
	"fmt"
	"net/http"
	"strings"

	pkgserver "github.com/openshift-online/rh-trex-ai/pkg/server"
)

func init() {
	pkgserver.RegisterPreAuthMiddleware(sanitizeAuthHeaders)
}

func sanitizeAuthHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		fwd := r.Header.Get(forwardedAccessTokenHeader)
		if auth == "" && fwd == "" {
			next.ServeHTTP(w, r)
			return
		}

		h := r.Header.Clone()
		if auth != "" {
			if token, ok := strings.CutPrefix(auth, "Bearer "); ok {
				h.Set("Authorization", fmt.Sprintf("Bearer [REDACTED:len=%d]", len(token)))
			} else {
				h.Set("Authorization", fmt.Sprintf("[REDACTED:len=%d]", len(auth)))
			}
		}
		if fwd != "" {
			h.Set(forwardedAccessTokenHeader, fmt.Sprintf("[REDACTED:len=%d]", len(fwd)))
		}

		r2 := r.WithContext(r.Context())
		r2.Header = h
		next.ServeHTTP(w, r2)
	})
}
