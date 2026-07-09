package gateway

import (
	"context"
	"testing"

	authv1 "k8s.io/api/authorization/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func TestResolveTier(t *testing.T) {
	tests := []struct {
		name                string
		username            string
		namespace           string
		canDeleteNamespace  bool
		canCreateDeployment bool
		canGetPods          bool
		expectedTier        Tier
	}{
		{
			name:               "admin access - can delete namespace",
			username:           "alice",
			namespace:          "proj-1",
			canDeleteNamespace: true,
			expectedTier:       TierAdmin,
		},
		{
			name:                "edit access - can create deployments",
			username:            "bob",
			namespace:           "proj-1",
			canCreateDeployment: true,
			expectedTier:        TierEditor,
		},
		{
			name:         "view access - can get pods",
			username:     "charlie",
			namespace:    "proj-1",
			canGetPods:   true,
			expectedTier: TierViewer,
		},
		{
			name:         "no access",
			username:     "dave",
			namespace:    "proj-1",
			expectedTier: TierNone,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := fake.NewSimpleClientset()

			// Mock SubjectAccessReview responses based on the new verb structure
			client.PrependReactor("create", "subjectaccessreviews", func(action k8stesting.Action) (bool, runtime.Object, error) {
				createAction := action.(k8stesting.CreateAction)
				sar := createAction.GetObject().(*authv1.SubjectAccessReview)

				result := &authv1.SubjectAccessReview{
					Status: authv1.SubjectAccessReviewStatus{
						Allowed: false,
					},
				}

				// Check user and namespace match
				if sar.Spec.User == tt.username && sar.Spec.ResourceAttributes.Namespace == tt.namespace {
					// Admin tier check: delete namespaces
					if sar.Spec.ResourceAttributes.Verb == "delete" &&
						sar.Spec.ResourceAttributes.Resource == "namespaces" {
						result.Status.Allowed = tt.canDeleteNamespace
					}

					// Editor tier check: create deployments in apps group
					if sar.Spec.ResourceAttributes.Verb == "create" &&
						sar.Spec.ResourceAttributes.Resource == "deployments" &&
						sar.Spec.ResourceAttributes.Group == "apps" {
						result.Status.Allowed = tt.canCreateDeployment
					}

					// Viewer tier check: get pods
					if sar.Spec.ResourceAttributes.Verb == "get" &&
						sar.Spec.ResourceAttributes.Resource == "pods" {
						result.Status.Allowed = tt.canGetPods
					}
				}

				return true, result, nil
			})

			// Create resolver with the fake client
			resolver := &TierResolver{
				k8sClient: client,
				enabled:   true,
			}

			tier := resolver.ResolveTier(context.Background(), tt.username, tt.namespace)
			if tier != tt.expectedTier {
				t.Errorf("ResolveTier() = %v, want %v", tier, tt.expectedTier)
			}
		})
	}
}

func TestResolveTier_Disabled(t *testing.T) {
	resolver := &TierResolver{
		enabled: false,
	}

	tier := resolver.ResolveTier(context.Background(), "alice", "proj-1")
	if tier != TierNone {
		t.Errorf("ResolveTier() with disabled resolver = %v, want %v", tier, TierNone)
	}
}

func TestResolveTier_NilClient(t *testing.T) {
	resolver := &TierResolver{
		k8sClient: nil,
		enabled:   true,
	}

	tier := resolver.ResolveTier(context.Background(), "alice", "proj-1")
	if tier != TierNone {
		t.Errorf("ResolveTier() with nil client = %v, want %v", tier, TierNone)
	}
}
