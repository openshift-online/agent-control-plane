package output

import (
	"fmt"

	"gopkg.in/yaml.v3"
)

// ConfigMapYAML generates a Kubernetes ConfigMap YAML document. The dataContent
// value is marshaled via yaml.Marshal to ensure correct quoting, block-scalar
// handling, and deterministic key order. The resulting YAML is suitable for
// kubectl apply.
func ConfigMapYAML(kind, name, namespace string, dataContent any) (string, error) {
	inner, err := yaml.Marshal(dataContent)
	if err != nil {
		return "", fmt.Errorf("marshal configmap data: %w", err)
	}

	cm := yaml.Node{Kind: yaml.MappingNode, Content: []*yaml.Node{
		{Kind: yaml.ScalarNode, Value: "apiVersion"},
		{Kind: yaml.ScalarNode, Value: "v1"},
		{Kind: yaml.ScalarNode, Value: "kind"},
		{Kind: yaml.ScalarNode, Value: "ConfigMap"},
		{Kind: yaml.ScalarNode, Value: "metadata"},
		{Kind: yaml.MappingNode, Content: []*yaml.Node{
			{Kind: yaml.ScalarNode, Value: "name"},
			{Kind: yaml.ScalarNode, Value: kind + "-" + name},
			{Kind: yaml.ScalarNode, Value: "namespace"},
			{Kind: yaml.ScalarNode, Value: namespace},
			{Kind: yaml.ScalarNode, Value: "labels"},
			{Kind: yaml.MappingNode, Content: []*yaml.Node{
				{Kind: yaml.ScalarNode, Value: "ambient.ai/kind"},
				{Kind: yaml.ScalarNode, Value: kind},
			}},
		}},
		{Kind: yaml.ScalarNode, Value: "data"},
		{Kind: yaml.MappingNode, Content: []*yaml.Node{
			{Kind: yaml.ScalarNode, Value: name},
			{Kind: yaml.ScalarNode, Value: string(inner), Style: yaml.LiteralStyle},
		}},
	}}

	doc := yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{&cm}}
	out, err := yaml.Marshal(&doc)
	if err != nil {
		return "", fmt.Errorf("marshal configmap: %w", err)
	}
	return string(out), nil
}
