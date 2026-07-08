package gateways_test

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

func TestGatewayCreate(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	gatewayInput := map[string]interface{}{
		"name":             "openshell-gateway",
		"project_id":       "test-project",
		"server_dns_names": []string{"openshell-gateway.test.svc.cluster.local"},
		"image":            "ghcr.io/nvidia/openshell:v0.0.70",
		"config":           "[openshell.gateway]\nbind_address = \"0.0.0.0:8080\"",
	}

	body, _ := json.Marshal(gatewayInput)
	resp, err := resty.R().
		SetHeader("Content-Type", "application/json").
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		SetBody(body).
		Post(h.RestURL("/projects/test-project/gateways"))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusCreated))

	var result map[string]interface{}
	Expect(json.Unmarshal(resp.Body(), &result)).NotTo(HaveOccurred())
	Expect(result["id"]).NotTo(BeEmpty())
	Expect(result["kind"]).To(Equal("Gateway"))
	Expect(result["name"]).To(Equal("openshell-gateway"))
	Expect(result["project_id"]).To(Equal("test-project"))
}

func TestGatewayGet(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	gatewayModel, err := newGateway(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	resp, err := resty.R().
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		Get(h.RestURL(fmt.Sprintf("/projects/test-project/gateways/%s", gatewayModel.ID)))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusOK))

	var result map[string]interface{}
	Expect(json.Unmarshal(resp.Body(), &result)).NotTo(HaveOccurred())
	Expect(result["id"]).To(Equal(gatewayModel.ID))
	Expect(result["kind"]).To(Equal("Gateway"))
}

func TestGatewayList(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	_, err := newGatewayList("gw", 3)
	Expect(err).NotTo(HaveOccurred())

	resp, err := resty.R().
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		Get(h.RestURL("/projects/test-project/gateways"))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusOK))

	var result map[string]interface{}
	Expect(json.Unmarshal(resp.Body(), &result)).NotTo(HaveOccurred())
	Expect(result["kind"]).To(Equal("GatewayList"))
}

func TestGatewayGetCrossProjectForbidden(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	gatewayModel, err := newGateway(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	resp, err := resty.R().
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		Get(h.RestURL(fmt.Sprintf("/projects/wrong-project/gateways/%s", gatewayModel.ID)))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusForbidden))
}

func TestGatewayDelete(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	gatewayModel, err := newGateway(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	resp, err := resty.R().
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		Delete(h.RestURL(fmt.Sprintf("/projects/test-project/gateways/%s", gatewayModel.ID)))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusNoContent))
}
