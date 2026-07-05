package platformInfo

import (
	"encoding/json"
	"net/http"

	"github.com/gorilla/mux"
	"github.com/openshift-online/rh-trex-ai/pkg/auth"
	"github.com/openshift-online/rh-trex-ai/pkg/environments"
	pkgserver "github.com/openshift-online/rh-trex-ai/pkg/server"
)

var responseBytes []byte

func init() {
	responseBytes, _ = json.Marshal(platformInfoResponse{
		GatewayMode: true,
	})

	pkgserver.RegisterRoutes("platformInfo", func(apiV1Router *mux.Router, _ pkgserver.ServicesInterface, authMiddleware environments.JWTMiddleware, _ auth.AuthorizationMiddleware) {
		router := apiV1Router.PathPrefix("/platform-info").Subrouter()
		router.HandleFunc("", handleGetPlatformInfo).Methods(http.MethodGet)
		router.Use(authMiddleware.AuthenticateAccountJWT)
	})
}

func handleGetPlatformInfo(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write(responseBytes)
}

type platformInfoResponse struct {
	GatewayMode bool `json:"gateway_mode"`
}
