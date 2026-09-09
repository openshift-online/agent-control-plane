package hypershell

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type testToken struct {
	token string
	err   error
}

func (t testToken) Token(context.Context) (string, error) { return t.token, t.err }

func TestReferenceCreateAndRecovery(t *testing.T) {
	var body map[string]interface{}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-management-identity" {
			t.Error("management identity was not sent")
		}
		switch r.Method {
		case http.MethodPost:
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			w.WriteHeader(http.StatusCreated)
			fmt.Fprint(w, `{"id":"gateway-one","external_reference":"instance/workspace"}`)
		case http.MethodGet:
			if r.URL.Query().Get("external_reference") != "instance/workspace" {
				t.Error("reference lookup was not exact")
			}
			fmt.Fprint(w, `{"items":[{"id":"gateway-one","external_reference":"instance/workspace"}]}`)
		}
	}))
	defer server.Close()
	client, err := NewClient(server.URL, testToken{token: "test-management-identity"}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	template := map[string]interface{}{"image": "gateway@sha256:example", "name": "bad-name", "external_reference": "bad-reference"}
	gateway, err := client.CreateGateway(context.Background(), "workspace", "instance/workspace", template)
	if err != nil {
		t.Fatal(err)
	}
	if body["name"] != "workspace" || body["external_reference"] != "instance/workspace" || template["name"] != "bad-name" {
		t.Fatal("binding override or template isolation failed")
	}
	recovered, err := client.FindGateway(context.Background(), "instance/workspace")
	if err != nil || recovered.ID != gateway.ID {
		t.Fatalf("recovery failed: %v", err)
	}
}

func TestManagementTrustAndErrors(t *testing.T) {
	if _, err := NewClient("http://gateway.test", testToken{}, nil); err == nil {
		t.Fatal("plaintext management endpoint accepted")
	}
	requests := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, "private-response-value")
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, testToken{err: fmt.Errorf("identity unavailable")}, server.Client())
	if _, err := client.GetGateway(context.Background(), "one"); err == nil || requests != 0 {
		t.Fatal("token failure did not fail closed")
	}
	client, _ = NewClient(server.URL, testToken{token: "test-management-identity"}, server.Client())
	_, err := client.GetGateway(context.Background(), "one")
	if err == nil || strings.Contains(err.Error(), "private-response-value") {
		t.Fatal("upstream secret response was exposed")
	}
	client, _ = NewClient(server.URL, testToken{token: "test-management-identity"}, nil)
	if _, err := client.GetGateway(context.Background(), "one"); err == nil {
		t.Fatal("untrusted TLS certificate accepted")
	}
}

func TestManagementRedirectDoesNotForwardIdentity(t *testing.T) {
	targetCalls := 0
	target := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { targetCalls++ }))
	defer target.Close()
	source := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	client, _ := NewClient(source.URL, testToken{token: "test-management-identity"}, source.Client())
	if _, err := client.GetGateway(context.Background(), "one"); err == nil || targetCalls != 0 {
		t.Fatal("management redirect followed")
	}
}
