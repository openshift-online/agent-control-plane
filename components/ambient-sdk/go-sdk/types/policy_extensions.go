package types

import "encoding/json"

// UnmarshalJSON handles the spec field being returned as either a JSON object
// or a JSON string from the API. The OpenAPI spec defines spec as type: object
// but the generated Policy struct uses string. This bridging ensures both forms
// deserialize correctly — objects are stored as their JSON string representation.
func (p *Policy) UnmarshalJSON(data []byte) error {
	type Alias Policy
	aux := &struct {
		Spec json.RawMessage `json:"spec,omitempty"`
		*Alias
	}{
		Alias: (*Alias)(p),
	}
	if err := json.Unmarshal(data, aux); err != nil {
		return err
	}
	if len(aux.Spec) > 0 {
		if aux.Spec[0] == '"' {
			return json.Unmarshal(aux.Spec, &p.Spec)
		}
		p.Spec = string(aux.Spec)
	}
	return nil
}
