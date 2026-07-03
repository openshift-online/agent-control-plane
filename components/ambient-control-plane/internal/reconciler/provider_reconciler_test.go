package reconciler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ambient-code/platform/components/ambient-control-plane/internal/kubeclient"
	"github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell"
	inferencepb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/inference/v1"
	pb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	"github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	"github.com/rs/zerolog"
	"google.golang.org/grpc/codes"
	grpcstatus "google.golang.org/grpc/status"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type mockGateway struct {
	updateProviderFn           func(ctx context.Context, namespace string, req *pb.UpdateProviderRequest) (*pb.ProviderResponse, error)
	createProviderFn           func(ctx context.Context, namespace string, req *pb.CreateProviderRequest) (*pb.ProviderResponse, error)
	setClusterInferenceFn      func(ctx context.Context, namespace string, req *inferencepb.SetClusterInferenceRequest) (*inferencepb.SetClusterInferenceResponse, error)
	configureProviderRefreshFn func(ctx context.Context, namespace string, req *pb.ConfigureProviderRefreshRequest) (*pb.ConfigureProviderRefreshResponse, error)
	rotateProviderCredentialFn func(ctx context.Context, namespace string, req *pb.RotateProviderCredentialRequest) (*pb.RotateProviderCredentialResponse, error)
}

func (m *mockGateway) CreateSandbox(_ context.Context, _ string, _ *pb.CreateSandboxRequest) (*pb.SandboxResponse, error) {
	return nil, nil
}

func (m *mockGateway) GetSandbox(_ context.Context, _ string, _ string) (*pb.SandboxResponse, error) {
	return nil, nil
}

func (m *mockGateway) DeleteSandbox(_ context.Context, _ string, _ string) error {
	return nil
}

func (m *mockGateway) CreateProvider(ctx context.Context, namespace string, req *pb.CreateProviderRequest) (*pb.ProviderResponse, error) {
	if m.createProviderFn != nil {
		return m.createProviderFn(ctx, namespace, req)
	}
	return &pb.ProviderResponse{}, nil
}

func (m *mockGateway) UpdateProvider(ctx context.Context, namespace string, req *pb.UpdateProviderRequest) (*pb.ProviderResponse, error) {
	if m.updateProviderFn != nil {
		return m.updateProviderFn(ctx, namespace, req)
	}
	return &pb.ProviderResponse{}, nil
}

func (m *mockGateway) SetClusterInference(ctx context.Context, namespace string, req *inferencepb.SetClusterInferenceRequest) (*inferencepb.SetClusterInferenceResponse, error) {
	if m.setClusterInferenceFn != nil {
		return m.setClusterInferenceFn(ctx, namespace, req)
	}
	return &inferencepb.SetClusterInferenceResponse{Version: 1}, nil
}

func (m *mockGateway) ConfigureProviderRefresh(ctx context.Context, namespace string, req *pb.ConfigureProviderRefreshRequest) (*pb.ConfigureProviderRefreshResponse, error) {
	if m.configureProviderRefreshFn != nil {
		return m.configureProviderRefreshFn(ctx, namespace, req)
	}
	return &pb.ConfigureProviderRefreshResponse{}, nil
}

func (m *mockGateway) RotateProviderCredential(ctx context.Context, namespace string, req *pb.RotateProviderCredentialRequest) (*pb.RotateProviderCredentialResponse, error) {
	if m.rotateProviderCredentialFn != nil {
		return m.rotateProviderCredentialFn(ctx, namespace, req)
	}
	return &pb.RotateProviderCredentialResponse{}, nil
}

func (m *mockGateway) ExecSandbox(_ context.Context, _ string, _ *pb.ExecSandboxRequest) (*openshell.ExecResult, error) {
	return &openshell.ExecResult{}, nil
}

func (m *mockGateway) ExecSandboxStreaming(_ context.Context, _ string, _ *pb.ExecSandboxRequest) error {
	return nil
}

func (m *mockGateway) UpdateConfig(_ context.Context, _ string, _ *pb.UpdateConfigRequest) (*pb.UpdateConfigResponse, error) {
	return &pb.UpdateConfigResponse{}, nil
}

func (m *mockGateway) UploadPayloads(_ context.Context, _ string, _ string, _ []openshell.Payload) error {
	return nil
}

func newFakeKubeClientWithSecrets(objects ...runtime.Object) *kubeclient.KubeClient {
	scheme := runtime.NewScheme()
	scheme.AddKnownTypeWithName(
		schema.GroupVersionKind{Group: "", Version: "v1", Kind: "Secret"},
		&unstructured.Unstructured{},
	)
	scheme.AddKnownTypeWithName(
		schema.GroupVersionKind{Group: "", Version: "v1", Kind: "SecretList"},
		&unstructured.UnstructuredList{},
	)
	dynClient := fake.NewSimpleDynamicClient(scheme, objects...)
	return kubeclient.NewFromDynamic(dynClient, zerolog.Nop())
}

func makeK8sSecret(namespace, name string, data map[string]string) *unstructured.Unstructured {
	encodedData := make(map[string]interface{})
	for k, v := range data {
		encodedData[k] = base64.StdEncoding.EncodeToString([]byte(v))
	}
	return &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "Secret",
			"metadata":   map[string]interface{}{"name": name, "namespace": namespace},
			"data":       encodedData,
		},
	}
}

func makeK8sSecretRaw(namespace, name string, data map[string]interface{}) *unstructured.Unstructured {
	return &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "Secret",
			"metadata":   map[string]interface{}{"name": name, "namespace": namespace},
			"data":       data,
		},
	}
}

type mockProviderPolicyData struct {
	providers map[string]types.Provider
	policies  map[string]types.Policy
}

func newProviderPolicyMockServer(data mockProviderPolicyData) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if strings.Contains(r.URL.Path, "/providers") && r.Method == "GET" {
			search := r.URL.Query().Get("search")
			name := extractTSLValue(search)
			var items []types.Provider
			if prov, ok := data.providers[name]; ok {
				items = append(items, prov)
			}
			resp := map[string]interface{}{
				"kind":  "ProviderList",
				"page":  1,
				"size":  len(items),
				"total": len(items),
				"items": items,
			}
			json.NewEncoder(w).Encode(resp)
			return
		}

		if strings.Contains(r.URL.Path, "/policies") && r.Method == "GET" {
			search := r.URL.Query().Get("search")
			name := extractTSLValue(search)
			var items []types.Policy
			if pol, ok := data.policies[name]; ok {
				items = append(items, pol)
			}
			resp := map[string]interface{}{
				"kind":  "PolicyList",
				"page":  1,
				"size":  len(items),
				"total": len(items),
				"items": items,
			}
			json.NewEncoder(w).Encode(resp)
			return
		}

		w.WriteHeader(http.StatusNotFound)
	}))
}

// ---------------------------------------------------------------------------
// readProviderSecretCredentials
// ---------------------------------------------------------------------------

func TestReadProviderSecretCredentials(t *testing.T) {
	tests := []struct {
		name      string
		objects   []runtime.Object
		namespace string
		secret    string
		wantKeys  map[string]string
		wantErr   string
	}{
		{
			name:      "good secret with multiple keys",
			objects:   []runtime.Object{makeK8sSecret("ns", "my-secret", map[string]string{"token": "sk-abc", "key": "val"})},
			namespace: "ns",
			secret:    "my-secret",
			wantKeys:  map[string]string{"token": "sk-abc", "key": "val"},
		},
		{
			name:      "single key",
			objects:   []runtime.Object{makeK8sSecret("ns", "single", map[string]string{"api-key": "my-key"})},
			namespace: "ns",
			secret:    "single",
			wantKeys:  map[string]string{"api-key": "my-key"},
		},
		{
			name:      "missing secret",
			objects:   []runtime.Object{},
			namespace: "ns",
			secret:    "nonexistent",
			wantErr:   "getting secret",
		},
		{
			name: "no data field",
			objects: []runtime.Object{&unstructured.Unstructured{
				Object: map[string]interface{}{
					"apiVersion": "v1",
					"kind":       "Secret",
					"metadata":   map[string]interface{}{"name": "empty", "namespace": "ns"},
				},
			}},
			namespace: "ns",
			secret:    "empty",
			wantErr:   "has no data",
		},
		{
			name: "empty data map",
			objects: []runtime.Object{&unstructured.Unstructured{
				Object: map[string]interface{}{
					"apiVersion": "v1",
					"kind":       "Secret",
					"metadata":   map[string]interface{}{"name": "empty-data", "namespace": "ns"},
					"data":       map[string]interface{}{},
				},
			}},
			namespace: "ns",
			secret:    "empty-data",
			wantErr:   "has no data",
		},
		{
			name: "bad base64",
			objects: []runtime.Object{makeK8sSecretRaw("ns", "bad-b64", map[string]interface{}{
				"key": "!!!not-valid-base64!!!",
			})},
			namespace: "ns",
			secret:    "bad-b64",
			wantErr:   "base64-decoding",
		},
		{
			name: "non-string values skipped",
			objects: []runtime.Object{makeK8sSecretRaw("ns", "mixed", map[string]interface{}{
				"good": base64.StdEncoding.EncodeToString([]byte("ok")),
				"bad":  int64(12345),
			})},
			namespace: "ns",
			secret:    "mixed",
			wantKeys:  map[string]string{"good": "ok"},
		},
		{
			name: "all non-string values",
			objects: []runtime.Object{makeK8sSecretRaw("ns", "all-bad", map[string]interface{}{
				"a": int64(123),
				"b": true,
			})},
			namespace: "ns",
			secret:    "all-bad",
			wantErr:   "no decodable keys",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logger := zerolog.New(zerolog.NewTestWriter(t))
			kube := newFakeKubeClientWithSecrets(tt.objects...)
			r := &SimpleKubeReconciler{kube: kube, logger: logger}

			got, err := r.readProviderSecretCredentials(context.Background(), tt.namespace, tt.secret)

			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("expected error containing %q, got %q", tt.wantErr, err.Error())
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			for k, want := range tt.wantKeys {
				if got[k] != want {
					t.Errorf("key %q: want %q, got %q", k, want, got[k])
				}
			}
			if len(got) != len(tt.wantKeys) {
				t.Errorf("expected %d keys, got %d: %v", len(tt.wantKeys), len(got), got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// resolveAgentSandboxPolicy
// ---------------------------------------------------------------------------

func TestResolveAgentSandboxPolicy(t *testing.T) {
	validSpec := `{"version":1,"filesystem":{"includeWorkdir":true}}`

	tests := []struct {
		name       string
		agent      *types.Agent
		policies   map[string]types.Policy
		wantPolicy bool
		wantErr    string
	}{
		{
			name:  "nil agent",
			agent: nil,
		},
		{
			name:  "empty sandbox policy",
			agent: &types.Agent{SandboxPolicy: ""},
		},
		{
			name:    "invalid policy name",
			agent:   &types.Agent{SandboxPolicy: "'; DROP TABLE--"},
			wantErr: "unsafe value",
		},
		{
			name:     "policy not found",
			agent:    &types.Agent{SandboxPolicy: "missing-policy"},
			policies: map[string]types.Policy{},
			wantErr:  "not found",
		},
		{
			name:  "valid policy with spec",
			agent: &types.Agent{SandboxPolicy: "restricted"},
			policies: map[string]types.Policy{
				"restricted": {
					ObjectReference: types.ObjectReference{ID: "pol-1"},
					Name:            "restricted",
					Spec:            validSpec,
				},
			},
			wantPolicy: true,
		},
		{
			name:  "empty spec returns nil",
			agent: &types.Agent{SandboxPolicy: "empty-spec"},
			policies: map[string]types.Policy{
				"empty-spec": {
					ObjectReference: types.ObjectReference{ID: "pol-2"},
					Name:            "empty-spec",
					Spec:            "",
				},
			},
		},
		{
			name:  "invalid JSON spec",
			agent: &types.Agent{SandboxPolicy: "bad-json"},
			policies: map[string]types.Policy{
				"bad-json": {
					ObjectReference: types.ObjectReference{ID: "pol-3"},
					Name:            "bad-json",
					Spec:            "not-json{{{",
				},
			},
			wantErr: "deserializing",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := newProviderPolicyMockServer(mockProviderPolicyData{policies: tt.policies})
			defer server.Close()

			logger := zerolog.New(zerolog.NewTestWriter(t))
			r := newTestReconciler(logger)
			sdk := newSDKClient(t, server.URL)

			policy, err := r.resolveAgentSandboxPolicy(context.Background(), sdk, "test-project", tt.agent)

			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("expected error containing %q, got %q", tt.wantErr, err.Error())
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tt.wantPolicy && policy == nil {
				t.Fatal("expected non-nil policy")
			}
			if !tt.wantPolicy && policy != nil {
				t.Fatalf("expected nil policy, got %v", policy)
			}
			if tt.wantPolicy && policy.Version != 1 {
				t.Errorf("expected policy version 1, got %d", policy.Version)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// resolveAgentProviders
// ---------------------------------------------------------------------------

func TestResolveAgentProviders(t *testing.T) {
	tests := []struct {
		name              string
		agent             *types.Agent
		providers         map[string]types.Provider
		secrets           []runtime.Object
		updateProviderFn  func(ctx context.Context, ns string, req *pb.UpdateProviderRequest) (*pb.ProviderResponse, error)
		createProviderFn  func(ctx context.Context, ns string, req *pb.CreateProviderRequest) (*pb.ProviderResponse, error)
		wantProviderNames []string
		wantInference     map[string]string
		wantErr           string
	}{
		{
			name:  "nil agent",
			agent: nil,
		},
		{
			name:  "empty providers",
			agent: &types.Agent{Providers: []string{}},
		},
		{
			name:          "provider not found in API",
			agent:         &types.Agent{Providers: []string{"missing"}},
			providers:     map[string]types.Provider{},
			wantInference: map[string]string{},
		},
		{
			name:          "invalid provider name skipped",
			agent:         &types.Agent{Providers: []string{"'; DROP TABLE"}},
			wantInference: map[string]string{},
		},
		{
			name:  "provider with no secret reference",
			agent: &types.Agent{Providers: []string{"no-secret"}},
			providers: map[string]types.Provider{
				"no-secret": {
					ObjectReference: types.ObjectReference{ID: "prov-1"},
					Name:            "no-secret",
					Type:            "github",
					Secret:          "",
				},
			},
			wantInference: map[string]string{},
		},
		{
			name:  "secret read failure",
			agent: &types.Agent{Providers: []string{"github-main"}},
			providers: map[string]types.Provider{
				"github-main": {
					ObjectReference: types.ObjectReference{ID: "prov-2"},
					Name:            "github-main",
					Type:            "github",
					Secret:          "nonexistent-secret",
				},
			},
			secrets: []runtime.Object{},
			wantErr: "reading secret",
		},
		{
			name:  "anthropic provider update succeeds",
			agent: &types.Agent{Providers: []string{"anthropic"}},
			providers: map[string]types.Provider{
				"anthropic": {
					ObjectReference: types.ObjectReference{ID: "prov-3"},
					Name:            "anthropic",
					Type:            "anthropic",
					Secret:          "anthropic-secret",
				},
			},
			secrets:           []runtime.Object{makeK8sSecret("test-ns", "anthropic-secret", map[string]string{"token": "sk-ant-xxx"})},
			wantProviderNames: []string{"proj-anthropic"},
			wantInference:     map[string]string{"proj-anthropic": "anthropic"},
		},
		{
			name:  "github provider not inference-capable",
			agent: &types.Agent{Providers: []string{"github-main"}},
			providers: map[string]types.Provider{
				"github-main": {
					ObjectReference: types.ObjectReference{ID: "prov-4"},
					Name:            "github-main",
					Type:            "github",
					Secret:          "gh-secret",
				},
			},
			secrets:           []runtime.Object{makeK8sSecret("test-ns", "gh-secret", map[string]string{"token": "ghp_xxx"})},
			wantProviderNames: []string{"proj-github-main"},
			wantInference:     map[string]string{},
		},
		{
			name:  "update NotFound then create succeeds",
			agent: &types.Agent{Providers: []string{"anthropic"}},
			providers: map[string]types.Provider{
				"anthropic": {
					ObjectReference: types.ObjectReference{ID: "prov-5"},
					Name:            "anthropic",
					Type:            "anthropic",
					Secret:          "anthropic-secret",
				},
			},
			secrets: []runtime.Object{makeK8sSecret("test-ns", "anthropic-secret", map[string]string{"token": "sk-ant-xxx"})},
			updateProviderFn: func(_ context.Context, _ string, _ *pb.UpdateProviderRequest) (*pb.ProviderResponse, error) {
				return nil, grpcstatus.Error(codes.NotFound, "provider not found")
			},
			wantProviderNames: []string{"proj-anthropic"},
			wantInference:     map[string]string{"proj-anthropic": "anthropic"},
		},
		{
			name:  "update non-NotFound error",
			agent: &types.Agent{Providers: []string{"anthropic"}},
			providers: map[string]types.Provider{
				"anthropic": {
					ObjectReference: types.ObjectReference{ID: "prov-6"},
					Name:            "anthropic",
					Type:            "anthropic",
					Secret:          "anthropic-secret",
				},
			},
			secrets: []runtime.Object{makeK8sSecret("test-ns", "anthropic-secret", map[string]string{"token": "sk-ant-xxx"})},
			updateProviderFn: func(_ context.Context, _ string, _ *pb.UpdateProviderRequest) (*pb.ProviderResponse, error) {
				return nil, grpcstatus.Error(codes.Internal, "server error")
			},
			wantErr: "updating provider",
		},
		{
			name:  "create fails after NotFound",
			agent: &types.Agent{Providers: []string{"anthropic"}},
			providers: map[string]types.Provider{
				"anthropic": {
					ObjectReference: types.ObjectReference{ID: "prov-7"},
					Name:            "anthropic",
					Type:            "anthropic",
					Secret:          "anthropic-secret",
				},
			},
			secrets: []runtime.Object{makeK8sSecret("test-ns", "anthropic-secret", map[string]string{"token": "sk-ant-xxx"})},
			updateProviderFn: func(_ context.Context, _ string, _ *pb.UpdateProviderRequest) (*pb.ProviderResponse, error) {
				return nil, grpcstatus.Error(codes.NotFound, "not found")
			},
			createProviderFn: func(_ context.Context, _ string, _ *pb.CreateProviderRequest) (*pb.ProviderResponse, error) {
				return nil, fmt.Errorf("create failed")
			},
			wantErr: "creating provider",
		},
		{
			name:  "multiple providers mixed inference",
			agent: &types.Agent{Providers: []string{"anthropic", "github-main"}},
			providers: map[string]types.Provider{
				"anthropic": {
					ObjectReference: types.ObjectReference{ID: "prov-8"},
					Name:            "anthropic",
					Type:            "anthropic",
					Secret:          "anthropic-secret",
				},
				"github-main": {
					ObjectReference: types.ObjectReference{ID: "prov-9"},
					Name:            "github-main",
					Type:            "github",
					Secret:          "gh-secret",
				},
			},
			secrets: []runtime.Object{
				makeK8sSecret("test-ns", "anthropic-secret", map[string]string{"token": "sk-ant-xxx"}),
				makeK8sSecret("test-ns", "gh-secret", map[string]string{"token": "ghp_xxx"}),
			},
			wantProviderNames: []string{"proj-anthropic", "proj-github-main"},
			wantInference:     map[string]string{"proj-anthropic": "anthropic"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := newProviderPolicyMockServer(mockProviderPolicyData{providers: tt.providers})
			defer server.Close()

			gw := &mockGateway{
				updateProviderFn: tt.updateProviderFn,
				createProviderFn: tt.createProviderFn,
			}

			logger := zerolog.New(zerolog.NewTestWriter(t))
			kube := newFakeKubeClientWithSecrets(tt.secrets...)
			r := &SimpleKubeReconciler{
				kube:    kube,
				gateway: gw,
				cfg:     KubeReconcilerConfig{},
				logger:  logger,
			}
			sdk := newSDKClient(t, server.URL)

			session := types.Session{
				ObjectReference: types.ObjectReference{ID: "sess-1"},
				ProjectID:       "test-project",
			}
			names, infProv, err := r.resolveAgentProviders(
				context.Background(), sdk, "test-ns", "proj", session, tt.agent,
			)

			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("expected error containing %q, got %q", tt.wantErr, err.Error())
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			if tt.wantProviderNames == nil {
				if names != nil {
					t.Errorf("expected nil providerNames, got %v", names)
				}
			} else {
				if len(names) != len(tt.wantProviderNames) {
					t.Fatalf("expected %d providers, got %d: %v", len(tt.wantProviderNames), len(names), names)
				}
				for i, want := range tt.wantProviderNames {
					if names[i] != want {
						t.Errorf("providerNames[%d]: want %q, got %q", i, want, names[i])
					}
				}
			}

			if tt.wantInference == nil {
				if infProv != nil {
					t.Errorf("expected nil inferenceProviders, got %v", infProv)
				}
			} else {
				if len(infProv) != len(tt.wantInference) {
					t.Errorf("expected %d inference providers, got %d: %v", len(tt.wantInference), len(infProv), infProv)
				}
				for k, want := range tt.wantInference {
					if infProv[k] != want {
						t.Errorf("inferenceProviders[%q]: want %q, got %q", k, want, infProv[k])
					}
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// configureInferenceFromProviders
// ---------------------------------------------------------------------------

func TestConfigureInferenceFromProviders(t *testing.T) {
	tests := []struct {
		name               string
		sessionModel       string
		inferenceProviders map[string]string
		setInferenceErr    error
		wantErr            string
		wantModel          string
		wantCallCount      int
	}{
		{
			name:               "empty providers",
			inferenceProviders: map[string]string{},
			wantCallCount:      0,
		},
		{
			name:               "single provider success",
			sessionModel:       "claude-sonnet-4-6",
			inferenceProviders: map[string]string{"proj-anthropic": "anthropic"},
			wantModel:          "claude-sonnet-4-6",
			wantCallCount:      1,
		},
		{
			name:               "default model when empty",
			sessionModel:       "",
			inferenceProviders: map[string]string{"proj-anthropic": "anthropic"},
			wantModel:          "claude-sonnet-4-6",
			wantCallCount:      1,
		},
		{
			name:               "custom model",
			sessionModel:       "claude-opus-4-6",
			inferenceProviders: map[string]string{"proj-anthropic": "anthropic"},
			wantModel:          "claude-opus-4-6",
			wantCallCount:      1,
		},
		{
			name:               "SetClusterInference fails",
			sessionModel:       "claude-sonnet-4-6",
			inferenceProviders: map[string]string{"proj-anthropic": "anthropic"},
			setInferenceErr:    fmt.Errorf("gateway unavailable"),
			wantErr:            "setting inference",
		},
		{
			name:               "non-inference-capable provider skipped",
			inferenceProviders: map[string]string{"proj-github": "github"},
			wantCallCount:      0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			type inferenceCall struct {
				providerName string
				modelID      string
			}
			var calls []inferenceCall
			gw := &mockGateway{
				setClusterInferenceFn: func(_ context.Context, _ string, req *inferencepb.SetClusterInferenceRequest) (*inferencepb.SetClusterInferenceResponse, error) {
					calls = append(calls, inferenceCall{providerName: req.ProviderName, modelID: req.ModelId})
					if tt.setInferenceErr != nil {
						return nil, tt.setInferenceErr
					}
					return &inferencepb.SetClusterInferenceResponse{Version: 1}, nil
				},
			}

			logger := zerolog.New(zerolog.NewTestWriter(t))
			r := &SimpleKubeReconciler{gateway: gw, logger: logger}

			err := r.configureInferenceFromProviders(
				context.Background(), "test-ns", tt.sessionModel, tt.inferenceProviders,
			)

			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("expected error containing %q, got %q", tt.wantErr, err.Error())
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(calls) != tt.wantCallCount {
				t.Errorf("expected %d SetClusterInference calls, got %d", tt.wantCallCount, len(calls))
			}
			if tt.wantModel != "" && len(calls) > 0 {
				if calls[0].modelID != tt.wantModel {
					t.Errorf("expected model %q, got %q", tt.wantModel, calls[0].modelID)
				}
			}
		})
	}
}
