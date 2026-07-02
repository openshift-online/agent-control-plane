package applications_test

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	. "github.com/onsi/gomega"
	"gopkg.in/resty.v1"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
	"github.com/ambient-code/platform/components/ambient-api-server/test"
)

func TestApplicationGet(t *testing.T) {
	h, client := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)

	_, _, err := client.DefaultAPI.ApiAmbientV1ApplicationsAppIdGet(context.Background(), "foo").Execute()
	Expect(err).To(HaveOccurred(), "Expected 401 but got nil error")

	_, resp, err := client.DefaultAPI.ApiAmbientV1ApplicationsAppIdGet(ctx, "foo").Execute()
	Expect(err).To(HaveOccurred(), "Expected 404")
	Expect(resp.StatusCode).To(Equal(http.StatusNotFound))

	applicationModel, err := newApplication(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	applicationOutput, resp, err := client.DefaultAPI.ApiAmbientV1ApplicationsAppIdGet(ctx, applicationModel.ID).Execute()
	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode).To(Equal(http.StatusOK))

	Expect(*applicationOutput.Id).To(Equal(applicationModel.ID), "found object does not match test object")
	Expect(*applicationOutput.Kind).To(Equal("Application"))
	Expect(*applicationOutput.Href).To(Equal(fmt.Sprintf("/api/ambient/v1/applications/%s", applicationModel.ID)))
	Expect(*applicationOutput.CreatedAt).To(BeTemporally("~", applicationModel.CreatedAt))
	Expect(*applicationOutput.UpdatedAt).To(BeTemporally("~", applicationModel.UpdatedAt))
	Expect(applicationOutput.Name).To(Equal(applicationModel.Name))
	Expect(applicationOutput.SourceRepoUrl).To(Equal(applicationModel.SourceRepoUrl))
	Expect(applicationOutput.SourcePath).To(Equal(applicationModel.SourcePath))
	Expect(applicationOutput.DestinationProject).To(Equal(applicationModel.DestinationProject))
}

func TestApplicationPost(t *testing.T) {
	h, client := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)

	applicationInput := openapi.Application{
		Name:               "fleet-prod",
		SourceRepoUrl:      "https://github.com/org/repo",
		SourcePath:         "agents/",
		DestinationProject: "prod",
	}

	applicationOutput, resp, err := client.DefaultAPI.ApiAmbientV1ApplicationsPost(ctx).Application(applicationInput).Execute()
	Expect(err).NotTo(HaveOccurred(), "Error posting object: %v", err)
	Expect(resp.StatusCode).To(Equal(http.StatusCreated))
	Expect(*applicationOutput.Id).NotTo(BeEmpty(), "Expected ID assigned on creation")
	Expect(*applicationOutput.Kind).To(Equal("Application"))
	Expect(*applicationOutput.Href).To(Equal(fmt.Sprintf("/api/ambient/v1/applications/%s", *applicationOutput.Id)))
	Expect(applicationOutput.Name).To(Equal("fleet-prod"))
	Expect(applicationOutput.SourceRepoUrl).To(Equal("https://github.com/org/repo"))
	Expect(applicationOutput.SourcePath).To(Equal("agents/"))
	Expect(applicationOutput.DestinationProject).To(Equal("prod"))

	jwtToken := ctx.Value(openapi.ContextAccessToken)
	restyResp, restyErr := resty.R().
		SetHeader("Content-Type", "application/json").
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		SetBody(`{ this is invalid }`).
		Post(h.RestURL("/applications"))

	Expect(restyErr).NotTo(HaveOccurred())
	Expect(restyResp.StatusCode()).To(Equal(http.StatusBadRequest))
}

func TestApplicationPostAllFields(t *testing.T) {
	h, client := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)

	applicationInput := openapi.Application{
		Name:                  "full-app",
		SourceRepoUrl:         "https://github.com/org/repo",
		SourceTargetRevision:  openapi.PtrString("main"),
		SourcePath:            "agents/prod/",
		DestinationAmbientUrl: openapi.PtrString("https://ambient.example.com"),
		DestinationProject:    "prod",
		CredentialId:          openapi.PtrString("cred-123"),
		AutoSync:              openapi.PtrBool(true),
		AutoPrune:             openapi.PtrBool(false),
		SelfHeal:              openapi.PtrBool(true),
		RetryLimit:            openapi.PtrInt32(5),
		Labels:                openapi.PtrString(`{"env":"prod"}`),
		Annotations:           openapi.PtrString(`{"note":"test"}`),
	}

	applicationOutput, resp, err := client.DefaultAPI.ApiAmbientV1ApplicationsPost(ctx).Application(applicationInput).Execute()
	Expect(err).NotTo(HaveOccurred(), "Error posting object: %v", err)
	Expect(resp.StatusCode).To(Equal(http.StatusCreated))
	Expect(applicationOutput.Name).To(Equal("full-app"))
	Expect(applicationOutput.SourceTargetRevision).To(Equal(openapi.PtrString("main")))
	Expect(applicationOutput.DestinationAmbientUrl).To(Equal(openapi.PtrString("https://ambient.example.com")))
	Expect(applicationOutput.CredentialId).To(Equal(openapi.PtrString("cred-123")))
	Expect(applicationOutput.AutoSync).To(Equal(openapi.PtrBool(true)))
	Expect(applicationOutput.AutoPrune).To(Equal(openapi.PtrBool(false)))
	Expect(applicationOutput.SelfHeal).To(Equal(openapi.PtrBool(true)))
	Expect(applicationOutput.RetryLimit).To(Equal(openapi.PtrInt32(5)))
	Expect(applicationOutput.Labels).To(Equal(openapi.PtrString(`{"env":"prod"}`)))
	Expect(applicationOutput.Annotations).To(Equal(openapi.PtrString(`{"note":"test"}`)))
}

func TestApplicationPostDefaultStatus(t *testing.T) {
	h, client := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)

	applicationInput := openapi.Application{
		Name:               "default-status-app",
		SourceRepoUrl:      "https://github.com/org/repo",
		SourcePath:         "agents/",
		DestinationProject: "default",
	}

	applicationOutput, _, err := client.DefaultAPI.ApiAmbientV1ApplicationsPost(ctx).Application(applicationInput).Execute()
	Expect(err).NotTo(HaveOccurred())
	Expect(applicationOutput.SyncStatus).To(Equal(openapi.PtrString("Unknown")))
	Expect(applicationOutput.HealthStatus).To(Equal(openapi.PtrString("Unknown")))
}

func TestApplicationPatch(t *testing.T) {
	h, client := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)

	applicationModel, err := newApplication(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	patchReq := openapi.ApplicationPatchRequest{
		Name:     openapi.PtrString("updated-name"),
		AutoSync: openapi.PtrBool(true),
	}

	applicationOutput, resp, err := client.DefaultAPI.ApiAmbientV1ApplicationsAppIdPatch(ctx, applicationModel.ID).ApplicationPatchRequest(patchReq).Execute()
	Expect(err).NotTo(HaveOccurred(), "Error patching object: %v", err)
	Expect(resp.StatusCode).To(Equal(http.StatusOK))
	Expect(*applicationOutput.Id).To(Equal(applicationModel.ID))
	Expect(applicationOutput.Name).To(Equal("updated-name"))
	Expect(applicationOutput.AutoSync).To(Equal(openapi.PtrBool(true)))
	Expect(applicationOutput.SourceRepoUrl).To(Equal(applicationModel.SourceRepoUrl))
	Expect(applicationOutput.SourcePath).To(Equal(applicationModel.SourcePath))
	Expect(applicationOutput.DestinationProject).To(Equal(applicationModel.DestinationProject))
	Expect(*applicationOutput.Kind).To(Equal("Application"))
	Expect(*applicationOutput.Href).To(Equal(fmt.Sprintf("/api/ambient/v1/applications/%s", *applicationOutput.Id)))

	jwtToken := ctx.Value(openapi.ContextAccessToken)
	restyResp, restyErr := resty.R().
		SetHeader("Content-Type", "application/json").
		SetHeader("Authorization", fmt.Sprintf("Bearer %s", jwtToken)).
		SetBody(`{ this is invalid }`).
		Patch(h.RestURL(fmt.Sprintf("/applications/%s", applicationModel.ID)))

	Expect(restyErr).NotTo(HaveOccurred())
	Expect(restyResp.StatusCode()).To(Equal(http.StatusBadRequest))
}

func TestApplicationPaging(t *testing.T) {
	h, client := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)

	_, err := newApplicationList("Bronto", 20)
	Expect(err).NotTo(HaveOccurred())

	list, _, err := client.DefaultAPI.ApiAmbientV1ApplicationsGet(ctx).Execute()
	Expect(err).NotTo(HaveOccurred(), "Error getting application list: %v", err)
	Expect(len(list.Items)).To(Equal(20))
	Expect(list.Size).To(Equal(int32(20)))
	Expect(list.Total).To(Equal(int32(20)))
	Expect(list.Page).To(Equal(int32(1)))

	list, _, err = client.DefaultAPI.ApiAmbientV1ApplicationsGet(ctx).Page(2).Size(5).Execute()
	Expect(err).NotTo(HaveOccurred(), "Error getting application list: %v", err)
	Expect(len(list.Items)).To(Equal(5))
	Expect(list.Size).To(Equal(int32(5)))
	Expect(list.Total).To(Equal(int32(20)))
	Expect(list.Page).To(Equal(int32(2)))
}

func TestApplicationListSearch(t *testing.T) {
	h, client := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)

	apps, err := newApplicationList("bronto", 20)
	Expect(err).NotTo(HaveOccurred())

	search := fmt.Sprintf("id in ('%s')", apps[0].ID)
	list, _, err := client.DefaultAPI.ApiAmbientV1ApplicationsGet(ctx).Search(search).Execute()
	Expect(err).NotTo(HaveOccurred(), "Error getting application list: %v", err)
	Expect(len(list.Items)).To(Equal(1))
	Expect(list.Total).To(Equal(int32(1)))
	Expect(*list.Items[0].Id).To(Equal(apps[0].ID))
}

func TestApplicationDelete(t *testing.T) {
	h, client := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)

	created, err := newApplication(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	_, resp, err := client.DefaultAPI.ApiAmbientV1ApplicationsAppIdGet(ctx, created.ID).Execute()
	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode).To(Equal(http.StatusOK))

	resp, err = client.DefaultAPI.ApiAmbientV1ApplicationsAppIdDelete(ctx, created.ID).Execute()
	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode).To(Equal(http.StatusNoContent))

	_, resp, err = client.DefaultAPI.ApiAmbientV1ApplicationsAppIdGet(ctx, created.ID).Execute()
	Expect(err).To(HaveOccurred(), "Expected 404 after delete")
	Expect(resp.StatusCode).To(Equal(http.StatusNotFound))

	resp, err = client.DefaultAPI.ApiAmbientV1ApplicationsAppIdDelete(context.Background(), created.ID).Execute()
	Expect(err).To(HaveOccurred(), "Expected 401 for unauthenticated delete")
	_ = resp
}

func TestApplicationSync(t *testing.T) {
	h, client := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)

	created, err := newApplication(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	synced, resp, err := client.DefaultAPI.ApiAmbientV1ApplicationsAppIdSyncPost(ctx, created.ID).Execute()
	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode).To(Equal(http.StatusOK))
	Expect(synced.OperationPhase).To(Equal(openapi.PtrString("Running")))
	Expect(synced.HealthStatus).To(Equal(openapi.PtrString("Unknown")))
}

func TestApplicationRefresh(t *testing.T) {
	h, client := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)

	created, err := newApplication(h.NewID())
	Expect(err).NotTo(HaveOccurred())

	refreshed, resp, err := client.DefaultAPI.ApiAmbientV1ApplicationsAppIdRefreshPost(ctx, created.ID).Execute()
	Expect(err).NotTo(HaveOccurred())
	Expect(resp.StatusCode).To(Equal(http.StatusOK))
	Expect(*refreshed.Id).To(Equal(created.ID))
	Expect(refreshed.Name).To(Equal(created.Name))
}

func TestApplicationSyncNotFound(t *testing.T) {
	h, client := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)

	_, resp, err := client.DefaultAPI.ApiAmbientV1ApplicationsAppIdSyncPost(ctx, "nonexistent").Execute()
	Expect(err).To(HaveOccurred())
	Expect(resp.StatusCode).To(Equal(http.StatusNotFound))
}

func TestApplicationRefreshNotFound(t *testing.T) {
	h, client := test.RegisterIntegration(t)

	account := h.NewRandAccount()
	ctx := h.NewAuthenticatedContext(account)

	_, resp, err := client.DefaultAPI.ApiAmbientV1ApplicationsAppIdRefreshPost(ctx, "nonexistent").Execute()
	Expect(err).To(HaveOccurred())
	Expect(resp.StatusCode).To(Equal(http.StatusNotFound))
}
