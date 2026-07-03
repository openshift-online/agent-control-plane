package gateway

import (
	"context"

	"github.com/golang/glog"
	authv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

type Tier string

const (
	TierAdmin  Tier = "admin"
	TierEditor Tier = "editor"
	TierViewer Tier = "viewer"
	TierNone   Tier = "none"
)

type TierResolver struct {
	k8sClient kubernetes.Interface
	enabled   bool
}

// NewTierResolver creates a resolver that checks Kubernetes namespace RBAC.
// If k8sClient is nil, all calls return TierNone.
func NewTierResolver() (*TierResolver, error) {
	// In-cluster configuration
	config, err := rest.InClusterConfig()
	if err != nil {
		glog.Warningf("Failed to load in-cluster config for tier resolver: %v", err)
		return &TierResolver{enabled: false}, nil
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		glog.Warningf("Failed to create k8s client for tier resolver: %v", err)
		return &TierResolver{enabled: false}, nil
	}

	return &TierResolver{
		k8sClient: clientset,
		enabled:   true,
	}, nil
}

// ResolveTier checks the user's Kubernetes namespace access and returns
// their effective ACP tier. Returns TierNone if the check fails.
//
// Mapping (based on representative capabilities):
//
//	delete namespace → TierAdmin (only admin/cluster-admin can)
//	create deployments → TierEditor (edit role grants, view does not)
//	get pods → TierViewer (basic read access)
//	no access → TierNone
func (r *TierResolver) ResolveTier(ctx context.Context, username, namespace string) Tier {
	if !r.enabled || r.k8sClient == nil {
		return TierNone
	}

	// Check admin access — can delete the namespace itself
	if r.hasAccess(ctx, username, namespace, "delete", "namespaces", "") {
		return TierAdmin
	}

	// Check editor access — can create deployments
	if r.hasAccess(ctx, username, namespace, "create", "deployments", "apps") {
		return TierEditor
	}

	// Check viewer access — can get pods
	if r.hasAccess(ctx, username, namespace, "get", "pods", "") {
		return TierViewer
	}

	return TierNone
}

// hasAccess performs a SubjectAccessReview to check if the user has the
// specified verb access on the given resource.
func (r *TierResolver) hasAccess(ctx context.Context, username, namespace, verb, resource, apiGroup string) bool {
	sar := &authv1.SubjectAccessReview{
		Spec: authv1.SubjectAccessReviewSpec{
			ResourceAttributes: &authv1.ResourceAttributes{
				Namespace: namespace,
				Verb:      verb,
				Resource:  resource,
				Group:     apiGroup,
			},
			User: username,
		},
	}

	result, err := r.k8sClient.AuthorizationV1().SubjectAccessReviews().Create(ctx, sar, metav1.CreateOptions{})
	if err != nil {
		glog.Warningf("SubjectAccessReview failed for user=%s namespace=%s verb=%s resource=%s: %v",
			username, namespace, verb, resource, err)
		return false
	}

	return result.Status.Allowed
}
