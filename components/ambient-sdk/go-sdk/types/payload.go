package types

type Payload struct {
	SandboxPath string `json:"sandbox_path"`
	Content     string `json:"content,omitempty"`
	RepoURL     string `json:"repo_url,omitempty"`
	Ref         string `json:"ref,omitempty"`
}
