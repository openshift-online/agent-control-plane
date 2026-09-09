package integration

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	. "github.com/onsi/gomega"
	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/api/openapi"
	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/test"
	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/environments"
	"gopkg.in/resty.v1"
)

func TestRunnerAccessUsesSessionRoleAndScopeWithoutMutation(t *testing.T) {
	RegisterTestingT(t)
	h := test.NewHelper(t)
	skipIfAuthzDisabled(t)
	h.DBFactory.ResetDB()
	ensureBuiltInRoles(t)
	for _, role := range []string{"project:viewer", "project:editor", "project:owner"} {
		t.Run(role, func(t *testing.T) {
			RegisterTestingT(t)
			username := "runner-access-" + role
			account := h.NewAccount(username, "Runner access test", "runner-access@test.com")
			token := h.NewAuthenticatedContext(account).Value(openapi.ContextAccessToken)
			project, _ := setupProjectWithRole(t, username, role)
			session := api.NewID()
			insertSession(t, session, "runner-access", project)
			otherProject, _ := setupProjectWithRole(t, "other-user", "project:owner")
			otherSession := api.NewID()
			insertSession(t, otherSession, "other-runner", otherProject)
			g := environments.Environment().Database.SessionFactory.New(context.Background())
			var before string
			Expect(g.Raw("SELECT row_to_json(s)::text FROM sessions s WHERE id = ?", session).Scan(&before).Error).NotTo(HaveOccurred())
			for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
				expected := http.StatusNoContent
				if role == "project:viewer" && method != http.MethodGet && method != http.MethodHead {
					expected = http.StatusForbidden
				}
				if role == "project:editor" && method == http.MethodDelete {
					expected = http.StatusForbidden
				}
				for _, id := range []string{session, otherSession} {
					want := expected
					if id == otherSession {
						want = http.StatusForbidden
						if method == http.MethodGet {
							want = http.StatusNotFound
						}
					}
					resp, err := resty.R().SetHeader("Authorization", fmt.Sprintf("Bearer %s", token)).Execute(method, h.RestURL("/sessions/"+id+"/runner/access"))
					Expect(err).NotTo(HaveOccurred())
					Expect(resp.StatusCode()).To(Equal(want), "role %s method %s", role, method)
				}
			}
			resp, err := resty.R().SetHeader("Authorization", fmt.Sprintf("Bearer %s", token)).Post(h.RestURL("/sessions/" + session + "/runner/access/stop"))
			Expect(err).NotTo(HaveOccurred())
			stopStatus := http.StatusForbidden
			if role == "project:owner" {
				stopStatus = http.StatusNoContent
			}
			Expect(resp.StatusCode()).To(Equal(stopStatus))
			var after string
			Expect(g.Raw("SELECT row_to_json(s)::text FROM sessions s WHERE id = ?", session).Scan(&after).Error).NotTo(HaveOccurred())
			Expect(after).To(Equal(before), "permission checks must not mutate the session")
		})
	}
}
