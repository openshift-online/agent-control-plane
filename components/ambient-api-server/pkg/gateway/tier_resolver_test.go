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
		name         string
		username     string
		namespace    string
		adminAllowed bool
		editAllowed  bool
		viewAllowed  bool
		expectedTier Tier
	}{
		{
			name:         "admin access",
			username:     "alice",
			namespace:    "proj-1",
			adminAllowed: true,
			expectedTier: TierAdmin,
		},
		{
			name:         "edit access",
			username:     "bob",
			namespace:    "proj-1",
			editAllowed:  true,
			expectedTier: TierEditor,
		},
		{
			name:         "view access",
			username:     "charlie",
			namespace:    "proj-1",
			viewAllowed:  true,
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

			// Mock SubjectAccessReview responses
			client.PrependReactor("create", "subjectaccessreviews", func(action k8stesting.Action) (bool, runtime.Object, error) {
				createAction := action.(k8stesting.CreateAction)
				sar := createAction.GetObject().(*authv1.SubjectAccessReview)

				result := &authv1.SubjectAccessReview{
					Status: authv1.SubjectAccessReviewStatus{
						Allowed: false,
					},
				}

				// Check which verb is being tested
				if sar.Spec.User == tt.username && sar.Spec.ResourceAttributes.Namespace == tt.namespace {
					switch sar.Spec.ResourceAttributes.Verb {
					case "admin":
						result.Status.Allowed = tt.adminAllowed
					case "edit":
						result.Status.Allowed = tt.editAllowed
					case "view":
						result.Status.Allowed = tt.viewAllowed
					}
				}

				return true, result, nil
			})

			// Create resolver with the fake client
			// Note: fake.Clientset satisfies the kubernetes.Interface
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
