package clusters_test

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

func TestClusterCreate(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	clusterInput := map[string]interface{}{
		"name":           "integration-cluster-1",
		"api_server_url": "https://k8s.example.com:6443",
		"role":           "hybrid",
	}

	body, _ := json.Marshal(clusterInput)
	resp, err := resty.R().
		SetHeader("Content-Type", "application/json").
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		SetBody(body).
		Post(h.RestURL("/clusters"))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusCreated))

	var result map[string]interface{}
	Expect(json.Unmarshal(resp.Body(), &result)).NotTo(HaveOccurred())
	Expect(result["id"]).NotTo(BeEmpty())
	Expect(result["kind"]).To(Equal("Cluster"))
	Expect(result["name"]).To(Equal("integration-cluster-1"))
	Expect(result["role"]).To(Equal("hybrid"))
	Expect(result["status"]).To(Equal("Unknown"))
}

func TestClusterCreateInvalidRole(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	clusterInput := map[string]interface{}{
		"name":           "bad-role-cluster",
		"api_server_url": "https://k8s.example.com:6443",
		"role":           "invalid",
	}

	body, _ := json.Marshal(clusterInput)
	resp, err := resty.R().
		SetHeader("Content-Type", "application/json").
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		SetBody(body).
		Post(h.RestURL("/clusters"))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusBadRequest))
}

func TestClusterGet(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	clusterModel, err := newCluster(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	resp, err := resty.R().
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		Get(h.RestURL(fmt.Sprintf("/clusters/%s", clusterModel.ID)))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusOK))

	var result map[string]interface{}
	Expect(json.Unmarshal(resp.Body(), &result)).NotTo(HaveOccurred())
	Expect(result["id"]).To(Equal(clusterModel.ID))
	Expect(result["kind"]).To(Equal("Cluster"))
}

func TestClusterList(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	_, err := newClusterList("list", 3)
	Expect(err).NotTo(HaveOccurred())

	resp, err := resty.R().
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		Get(h.RestURL("/clusters"))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusOK))

	var result map[string]interface{}
	Expect(json.Unmarshal(resp.Body(), &result)).NotTo(HaveOccurred())
	Expect(result["kind"]).To(Equal("ClusterList"))
}

func TestClusterPatch(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	clusterModel, err := newCluster(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	patchBody := map[string]interface{}{
		"role": "gateway",
	}
	body, _ := json.Marshal(patchBody)
	resp, err := resty.R().
		SetHeader("Content-Type", "application/json").
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		SetBody(body).
		Patch(h.RestURL(fmt.Sprintf("/clusters/%s", clusterModel.ID)))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusOK))

	var result map[string]interface{}
	Expect(json.Unmarshal(resp.Body(), &result)).NotTo(HaveOccurred())
	Expect(result["role"]).To(Equal("gateway"))
}

func TestClusterDelete(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	clusterModel, err := newCluster(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	resp, err := resty.R().
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		Delete(h.RestURL(fmt.Sprintf("/clusters/%s", clusterModel.ID)))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusNoContent))
}

func TestClusterGetStatus(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	clusterModel, err := newCluster(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	resp, err := resty.R().
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		Get(h.RestURL(fmt.Sprintf("/clusters/%s/status", clusterModel.ID)))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusOK))

	var result map[string]interface{}
	Expect(json.Unmarshal(resp.Body(), &result)).NotTo(HaveOccurred())
	Expect(result["id"]).To(Equal(clusterModel.ID))
	Expect(result["status"]).To(Equal("Unknown"))
}

func TestClusterHeartbeat(t *testing.T) {
	h, _ := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)
	jwtToken := ctx.Value(openapi.ContextAccessToken)

	clusterModel, err := newCluster(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	resp, err := resty.R().
		SetHeader("Content-Type", "application/json").
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		SetBody("{}").
		Post(h.RestURL(fmt.Sprintf("/clusters/%s/heartbeat", clusterModel.ID)))

	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode()).To(Equal(http.StatusOK))

	var result map[string]interface{}
	Expect(json.Unmarshal(resp.Body(), &result)).NotTo(HaveOccurred())
	Expect(result["id"]).To(Equal(clusterModel.ID))
	Expect(result["last_heartbeat_at"]).NotTo(BeEmpty())
}
