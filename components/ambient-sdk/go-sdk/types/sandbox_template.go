package types

type SandboxTemplate struct {
	Image            string                 `json:"image,omitempty"`
	Resources        *ResourceRequirements  `json:"resources,omitempty"`
	Gpu              *GpuRequirements       `json:"gpu,omitempty"`
	RuntimeClassName string                 `json:"runtime_class_name,omitempty"`
	DriverConfig     map[string]interface{} `json:"driver_config,omitempty"`
	Labels           map[string]string      `json:"labels,omitempty"`
	Annotations      map[string]string      `json:"annotations,omitempty"`
	LogLevel         string                 `json:"log_level,omitempty"`
}

type ResourceRequirements struct {
	CPU    string `json:"cpu,omitempty"`
	Memory string `json:"memory,omitempty"`
}

type GpuRequirements struct {
	Count int `json:"count,omitempty"`
}
