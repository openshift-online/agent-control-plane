package sessions

import (
	"net/http"

	"github.com/gorilla/mux"
	"github.com/openshift-online/rh-trex-ai/pkg/handlers"
)

// RunnerAccess has no side effects. The session router applies JWT authentication
// and database RBAC to the actual request method and session scope. The /stop
// variant uses the existing session:stop action, as does the public task route.
func (h sessionHandler) RunnerAccess(w http.ResponseWriter, r *http.Request) {
	if _, err := h.session.Get(r.Context(), mux.Vars(r)["id"]); err != nil {
		handlers.HandleError(r.Context(), w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
