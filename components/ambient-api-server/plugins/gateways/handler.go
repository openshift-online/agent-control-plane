package gateways

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"regexp"

	"github.com/gorilla/mux"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
	"github.com/ambient-code/platform/components/ambient-api-server/pkg/gateway"
	pkgrbac "github.com/ambient-code/platform/components/ambient-api-server/pkg/rbac"
	"github.com/openshift-online/rh-trex-ai/pkg/api/presenters"
	"github.com/openshift-online/rh-trex-ai/pkg/errors"
	"github.com/openshift-online/rh-trex-ai/pkg/handlers"
	"github.com/openshift-online/rh-trex-ai/pkg/services"
)

var validIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_\-]+$`)

var DefaultGatewayImage = gatewayImageFromEnv()

func gatewayImageFromEnv() string {
	if v := os.Getenv("GATEWAY_IMAGE"); v != "" {
		return v
	}
	return "ghcr.io/nvidia/openshell/gateway:0.0.83"
}

var DefaultOIDCIssuerURL = oidcIssuerURLFromEnv()

func oidcIssuerURLFromEnv() string {
	return os.Getenv("OIDC_ISSUER_URL")
}

func applyGatewayDefaults(gw *Gateway, projectID string) {
	if gw.Name == "" {
		gw.Name = "openshell-gateway"
	}
	if gw.Image == nil || *gw.Image == "" {
		img := DefaultGatewayImage
		gw.Image = &img
	}
	if gw.ServerDnsNames == nil {
		dnsNames := []string{gw.Name + "." + projectID + ".svc.cluster.local"}
		raw, _ := json.Marshal(dnsNames)
		s := string(raw)
		gw.ServerDnsNames = &s
	}
	if gw.Oidc == nil && DefaultOIDCIssuerURL != "" {
		oidcDefaults := map[string]interface{}{
			"issuer":      DefaultOIDCIssuerURL,
			"audience":    "openshell-cli",
			"roles_claim": "realm_access.roles",
			"admin_role":  "openshell-admin",
			"user_role":   "openshell-user",
		}
		raw, _ := json.Marshal(oidcDefaults)
		s := string(raw)
		gw.Oidc = &s
	}
	if gw.Route == nil {
		routeDefault := map[string]interface{}{}
		raw, _ := json.Marshal(routeDefault)
		s := string(raw)
		gw.Route = &s
	}
	if gw.Labels == nil {
		labelsDefault := map[string]string{
			"purpose": "openshell",
			"env":     "dev",
			"auth":    "oidc",
		}
		raw, _ := json.Marshal(labelsDefault)
		s := string(raw)
		gw.Labels = &s
	}
}

var _ handlers.RestHandler = gatewayHandler{}

type gatewayHandler struct {
	gateway GatewayService
	generic services.GenericService
}

func NewGatewayHandler(gw GatewayService, generic services.GenericService) *gatewayHandler {
	return &gatewayHandler{
		gateway: gw,
		generic: generic,
	}
}

func (h gatewayHandler) Create(w http.ResponseWriter, r *http.Request) {
	var gw openapi.Gateway
	cfg := &handlers.HandlerConfig{
		Body: &gw,
		Validators: []handlers.Validate{
			handlers.ValidateEmpty(&gw, "Id", "id"),
		},
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()
			projectID := mux.Vars(r)["id"]
			if !validIDPattern.MatchString(projectID) {
				return nil, errors.Validation("invalid project id")
			}
			if err := gateway.CheckAdminTier(ctx, projectID); err != nil {
				return nil, err
			}
			gatewayModel := ConvertGateway(gw)
			gatewayModel.ProjectId = projectID
			applyGatewayDefaults(gatewayModel, projectID)
			if gatewayModel.Name == "" {
				return nil, errors.Validation("gateway name is required")
			}
			gatewayModel, svcErr := h.gateway.Create(ctx, gatewayModel)
			if svcErr != nil {
				return nil, svcErr
			}
			return PresentGateway(gatewayModel), nil
		},
		ErrorHandler: handlers.HandleError,
	}

	handlers.Handle(w, r, cfg, http.StatusCreated)
}

func (h gatewayHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var patch openapi.GatewayPatchRequest

	// Pre-read body to detect explicit null for JSONB fields (route, oidc).
	// Go's JSON decoder treats absent and null identically for pointer types.
	var nullableFields map[string]json.RawMessage
	if bodyBytes, readErr := io.ReadAll(r.Body); readErr == nil {
		r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		_ = json.Unmarshal(bodyBytes, &nullableFields)
	}

	cfg := &handlers.HandlerConfig{
		Body:       &patch,
		Validators: []handlers.Validate{},
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()
			projectID := mux.Vars(r)["id"]
			gatewayID := mux.Vars(r)["gateway_id"]
			if !validIDPattern.MatchString(projectID) || !validIDPattern.MatchString(gatewayID) {
				return nil, errors.Validation("invalid project or gateway id")
			}
			if err := gateway.CheckEditorTier(ctx, projectID); err != nil {
				return nil, err
			}
			found, svcErr := h.gateway.Get(ctx, gatewayID)
			if svcErr != nil {
				return nil, svcErr
			}
			if found.ProjectId != projectID {
				return nil, errors.Forbidden("gateway does not belong to this project")
			}

			if patch.Name != nil {
				found.Name = *patch.Name
			}
			if patch.Image != nil {
				found.Image = patch.Image
			}
			if patch.ServerDnsNames != nil {
				raw, merr := json.Marshal(patch.ServerDnsNames)
				if merr != nil {
					return nil, errors.GeneralError("failed to marshal server_dns_names: %v", merr)
				}
				s := string(raw)
				found.ServerDnsNames = &s
			}
			if patch.Config != nil {
				found.Config = patch.Config
			}
			if patch.Labels != nil {
				found.Labels = patch.Labels
			}
			if patch.Annotations != nil {
				found.Annotations = patch.Annotations
			}
			if patch.Oidc != nil {
				raw, merr := json.Marshal(patch.Oidc)
				if merr != nil {
					return nil, errors.GeneralError("failed to marshal oidc: %v", merr)
				}
				s := string(raw)
				found.Oidc = &s
			} else if rawVal, exists := nullableFields["oidc"]; exists && string(rawVal) == "null" {
				found.Oidc = nil
			}
			if patch.Route != nil {
				raw, merr := json.Marshal(patch.Route)
				if merr != nil {
					return nil, errors.GeneralError("failed to marshal route: %v", merr)
				}
				s := string(raw)
				found.Route = &s
			} else if rawVal, exists := nullableFields["route"]; exists && string(rawVal) == "null" {
				found.Route = nil
			}
			if patch.RouteAddress != nil {
				found.RouteAddress = patch.RouteAddress
			}

			gatewayModel, svcErr := h.gateway.Replace(ctx, found)
			if svcErr != nil {
				return nil, svcErr
			}
			return PresentGateway(gatewayModel), nil
		},
		ErrorHandler: handlers.HandleError,
	}

	handlers.Handle(w, r, cfg, http.StatusOK)
}

func (h gatewayHandler) List(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()
			projectID := mux.Vars(r)["id"]

			if !validIDPattern.MatchString(projectID) {
				return nil, errors.Validation("invalid project id")
			}

			listArgs := services.NewListArguments(r.URL.Query())
			projectFilter, filterErr := pkgrbac.TSLEqual("project_id", projectID)
			if filterErr != nil {
				return nil, errors.Validation("invalid project_id format")
			}
			pkgrbac.PrependTSLFilter(listArgs, projectFilter)
			if !pkgrbac.ApplyListFilter(ctx, listArgs, "project_id", false) {
				return openapi.GatewayList{Kind: "GatewayList", Page: 1, Size: 0, Total: 0, Items: []openapi.Gateway{}}, nil
			}

			var gatewaysList []Gateway
			paging, svcErr := h.generic.List(ctx, "id", listArgs, &gatewaysList)
			if svcErr != nil {
				return nil, svcErr
			}
			gatewayList := openapi.GatewayList{
				Kind:  "GatewayList",
				Page:  int32(paging.Page),
				Size:  int32(paging.Size),
				Total: int32(paging.Total),
				Items: []openapi.Gateway{},
			}

			for _, gw := range gatewaysList {
				converted := PresentGateway(&gw)
				gatewayList.Items = append(gatewayList.Items, converted)
			}
			if listArgs.Fields != nil {
				filteredItems, fieldErr := presenters.SliceFilter(listArgs.Fields, gatewayList.Items)
				if fieldErr != nil {
					return nil, fieldErr
				}
				return filteredItems, nil
			}
			return gatewayList, nil
		},
	}

	handlers.HandleList(w, r, cfg)
}

func (h gatewayHandler) Get(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			projectID := mux.Vars(r)["id"]
			gatewayID := mux.Vars(r)["gateway_id"]
			if !validIDPattern.MatchString(projectID) || !validIDPattern.MatchString(gatewayID) {
				return nil, errors.Validation("invalid project or gateway id")
			}
			ctx := r.Context()
			gw, svcErr := h.gateway.Get(ctx, gatewayID)
			if svcErr != nil {
				return nil, svcErr
			}
			if gw.ProjectId != projectID {
				return nil, errors.Forbidden("gateway does not belong to this project")
			}

			return PresentGateway(gw), nil
		},
	}

	handlers.HandleGet(w, r, cfg)
}

func (h gatewayHandler) Delete(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			projectID := mux.Vars(r)["id"]
			gatewayID := mux.Vars(r)["gateway_id"]
			if !validIDPattern.MatchString(projectID) || !validIDPattern.MatchString(gatewayID) {
				return nil, errors.Validation("invalid project or gateway id")
			}
			ctx := r.Context()
			if err := gateway.CheckAdminTier(ctx, projectID); err != nil {
				return nil, err
			}
			gw, svcErr := h.gateway.Get(ctx, gatewayID)
			if svcErr != nil {
				return nil, svcErr
			}
			if gw.ProjectId != projectID {
				return nil, errors.Forbidden("gateway does not belong to this project")
			}
			svcErr = h.gateway.Delete(ctx, gatewayID)
			if svcErr != nil {
				return nil, svcErr
			}
			return nil, nil
		},
	}
	handlers.HandleDelete(w, r, cfg, http.StatusNoContent)
}
