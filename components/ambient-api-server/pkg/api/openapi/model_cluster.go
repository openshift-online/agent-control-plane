package openapi

import "time"

type Cluster struct {
	Id              *string    `json:"id,omitempty"`
	Kind            *string    `json:"kind,omitempty"`
	Href            *string    `json:"href,omitempty"`
	CreatedAt       *time.Time `json:"created_at,omitempty"`
	UpdatedAt       *time.Time `json:"updated_at,omitempty"`
	Name            string     `json:"name"`
	Description     *string    `json:"description,omitempty"`
	ApiServerUrl    string     `json:"api_server_url"`
	CredentialId    *string    `json:"credential_id,omitempty"`
	Role            string     `json:"role"`
	Status          *string    `json:"status,omitempty"`
	StatusMessage   *string    `json:"status_message,omitempty"`
	Labels          *string    `json:"labels,omitempty"`
	Annotations     *string    `json:"annotations,omitempty"`
	Capacity        *string    `json:"capacity,omitempty"`
	LastHeartbeatAt *time.Time `json:"last_heartbeat_at,omitempty"`
}

type ClusterList struct {
	Kind  string    `json:"kind"`
	Page  int32     `json:"page"`
	Size  int32     `json:"size"`
	Total int32     `json:"total"`
	Items []Cluster `json:"items"`
}

type ClusterPatchRequest struct {
	Name         *string `json:"name,omitempty"`
	Description  *string `json:"description,omitempty"`
	ApiServerUrl *string `json:"api_server_url,omitempty"`
	CredentialId *string `json:"credential_id,omitempty"`
	Role         *string `json:"role,omitempty"`
	Labels       *string `json:"labels,omitempty"`
	Annotations  *string `json:"annotations,omitempty"`
}

type ClusterStatusResponse struct {
	Id              *string    `json:"id,omitempty"`
	Status          *string    `json:"status,omitempty"`
	StatusMessage   *string    `json:"status_message,omitempty"`
	Capacity        *string    `json:"capacity,omitempty"`
	LastHeartbeatAt *time.Time `json:"last_heartbeat_at,omitempty"`
}
