package providers_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	. "github.com/onsi/gomega"
	"gopkg.in/resty.v1"

	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/api/openapi"
	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/test"
)

func TestProviderCreate(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	providerInput := map[string]interface{}{
		"name":       "vertex",
		"project_id": "test-project",
		"type":       "llm",
		"secret":     "vertex-secret",
		"namespace":  "default",
	}

	body, _ := json.Marshal(providerInput)
	resp, err := resty.R().
		SetHeader("Content-Type", "application/json").
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		SetBody(body).
		Post(h.RestURL("/projects/test-project/providers"))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusCreated))

	var result map[string]interface{}
	Expect(json.Unmarshal(resp.Body(), &result)).NotTo(HaveOccurred())
	Expect(result["id"]).NotTo(BeEmpty())
	Expect(result["kind"]).To(Equal("Provider"))
	Expect(result["name"]).To(Equal("vertex"))
	Expect(result["project_id"]).To(Equal("test-project"))
	Expect(result["type"]).To(Equal("llm"))
}

func TestProviderGet(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	providerModel, err := newProvider(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	resp, err := resty.R().
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		Get(h.RestURL(fmt.Sprintf("/projects/test-project/providers/%s", providerModel.ID)))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusOK))

	var result map[string]interface{}
	Expect(json.Unmarshal(resp.Body(), &result)).NotTo(HaveOccurred())
	Expect(result["id"]).To(Equal(providerModel.ID))
	Expect(result["kind"]).To(Equal("Provider"))
}

func TestProviderList(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	_, err := newProviderList("prov", 3)
	Expect(err).NotTo(HaveOccurred())

	resp, err := resty.R().
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		Get(h.RestURL("/projects/test-project/providers"))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusOK))

	var result map[string]interface{}
	Expect(json.Unmarshal(resp.Body(), &result)).NotTo(HaveOccurred())
	Expect(result["kind"]).To(Equal("ProviderList"))
}

func TestProviderPatch(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	providerModel, err := newProvider(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	patchBody := map[string]interface{}{
		"name": "updated-vertex",
		"type": "mcp",
	}
	body, _ := json.Marshal(patchBody)
	resp, err := resty.R().
		SetHeader("Content-Type", "application/json").
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		SetBody(body).
		Patch(h.RestURL(fmt.Sprintf("/projects/test-project/providers/%s", providerModel.ID)))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusOK))

	var result map[string]interface{}
	Expect(json.Unmarshal(resp.Body(), &result)).NotTo(HaveOccurred())
	Expect(result["name"]).To(Equal("updated-vertex"))
	Expect(result["type"]).To(Equal("mcp"))
}

func TestProviderGetCrossProjectForbidden(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	providerModel, err := newProvider(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	resp, err := resty.R().
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		Get(h.RestURL(fmt.Sprintf("/projects/wrong-project/providers/%s", providerModel.ID)))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusForbidden))
}

func TestProviderDelete(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	providerModel, err := newProvider(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	resp, err := resty.R().
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		Delete(h.RestURL(fmt.Sprintf("/projects/test-project/providers/%s", providerModel.ID)))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusNoContent))
}
