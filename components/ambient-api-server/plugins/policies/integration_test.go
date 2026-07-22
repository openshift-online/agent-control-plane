package policies_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	. "github.com/onsi/gomega"
	"gopkg.in/resty.v1"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
	"github.com/ambient-code/platform/components/ambient-api-server/test"
)

func TestPolicyCreate(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	policyInput := map[string]interface{}{
		"name":       "permissive",
		"project_id": "test-project",
		"namespace":  "default",
		"spec": map[string]interface{}{
			"allowed_tools":  []string{"bash", "read", "write"},
			"max_iterations": 100,
		},
	}

	body, _ := json.Marshal(policyInput)
	resp, err := resty.R().
		SetHeader("Content-Type", "application/json").
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		SetBody(body).
		Post(h.RestURL("/projects/test-project/policies"))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusCreated))

	var result map[string]interface{}
	Expect(json.Unmarshal(resp.Body(), &result)).NotTo(HaveOccurred())
	Expect(result["id"]).NotTo(BeEmpty())
	Expect(result["kind"]).To(Equal("Policy"))
	Expect(result["name"]).To(Equal("permissive"))
	Expect(result["project_id"]).To(Equal("test-project"))
}

func TestPolicyGet(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	policyModel, err := newPolicy(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	resp, err := resty.R().
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		Get(h.RestURL(fmt.Sprintf("/projects/test-project/policies/%s", policyModel.ID)))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusOK))

	var result map[string]interface{}
	Expect(json.Unmarshal(resp.Body(), &result)).NotTo(HaveOccurred())
	Expect(result["id"]).To(Equal(policyModel.ID))
	Expect(result["kind"]).To(Equal("Policy"))
}

func TestPolicyList(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	_, err := newPolicyList("pol", 3)
	Expect(err).NotTo(HaveOccurred())

	resp, err := resty.R().
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		Get(h.RestURL("/projects/test-project/policies"))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusOK))

	var result map[string]interface{}
	Expect(json.Unmarshal(resp.Body(), &result)).NotTo(HaveOccurred())
	Expect(result["kind"]).To(Equal("PolicyList"))
}

func TestPolicyPatch(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	policyModel, err := newPolicy(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	patchBody := map[string]interface{}{
		"name": "restrictive",
		"spec": map[string]interface{}{
			"allowed_tools":  []string{"read"},
			"max_iterations": 10,
		},
	}
	body, _ := json.Marshal(patchBody)
	resp, err := resty.R().
		SetHeader("Content-Type", "application/json").
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		SetBody(body).
		Patch(h.RestURL(fmt.Sprintf("/projects/test-project/policies/%s", policyModel.ID)))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusOK))

	var result map[string]interface{}
	Expect(json.Unmarshal(resp.Body(), &result)).NotTo(HaveOccurred())
	Expect(result["name"]).To(Equal("restrictive"))
}

func TestPolicyGetCrossProjectForbidden(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	policyModel, err := newPolicy(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	resp, err := resty.R().
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		Get(h.RestURL(fmt.Sprintf("/projects/wrong-project/policies/%s", policyModel.ID)))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusForbidden))
}

func TestPolicyDelete(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	policyModel, err := newPolicy(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	resp, err := resty.R().
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		Delete(h.RestURL(fmt.Sprintf("/projects/test-project/policies/%s", policyModel.ID)))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusNoContent))
}
