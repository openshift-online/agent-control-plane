package gateway

import (
	"testing"
)

func TestKindToResource(t *testing.T) {
	tests := []struct {
		name string
		kind string
		want string
	}{
		{
			name: "ServiceAccount",
			kind: "ServiceAccount",
			want: "serviceaccounts",
		},
		{
			name: "ConfigMap",
			kind: "ConfigMap",
			want: "configmaps",
		},
		{
			name: "Service",
			kind: "Service",
			want: "services",
		},
		{
			name: "StatefulSet",
			kind: "StatefulSet",
			want: "statefulsets",
		},
		{
			name: "NetworkPolicy",
			kind: "NetworkPolicy",
			want: "networkpolicies",
		},
		{
			name: "ClusterRole",
			kind: "ClusterRole",
			want: "clusterroles",
		},
		{
			name: "ClusterRoleBinding",
			kind: "ClusterRoleBinding",
			want: "clusterrolebindings",
		},
		{
			name: "Job",
			kind: "Job",
			want: "jobs",
		},
		{
			name: "Role",
			kind: "Role",
			want: "roles",
		},
		{
			name: "RoleBinding",
			kind: "RoleBinding",
			want: "rolebindings",
		},
		{
			name: "Secret",
			kind: "Secret",
			want: "secrets",
		},
		{
			name: "unknown kind fallback",
			kind: "CustomResource",
			want: "customresources",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := kindToResource(tt.kind)
			if got != tt.want {
				t.Errorf("kindToResource(%s) = %s, want %s", tt.kind, got, tt.want)
			}
		})
	}
}
