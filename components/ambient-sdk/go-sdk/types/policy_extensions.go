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

// MarshalJSON ensures the string Spec field is serialized as a JSON object,
// matching the OpenAPI spec (type: object). Without this, the string gets
// double-encoded as "spec":"{...}" instead of "spec":{...}.
func (p Policy) MarshalJSON() ([]byte, error) {
	type Alias Policy
	aux := &struct {
		Spec json.RawMessage `json:"spec,omitempty"`
		*Alias
	}{
		Alias: (*Alias)(&p),
	}
	if p.Spec != "" {
		if json.Valid([]byte(p.Spec)) {
			aux.Spec = json.RawMessage(p.Spec)
		} else {
			b, err := json.Marshal(p.Spec)
			if err != nil {
				return nil, err
			}
			aux.Spec = b
		}
	}
	return json.Marshal(aux)
}

// SpecAsObject converts a JSON string to a json.RawMessage for use in patch payloads,
// ensuring it is sent as a JSON object rather than a double-encoded string.
func SpecAsObject(spec string) (json.RawMessage, error) {
	if spec == "" {
		return nil, nil
	}
	if json.Valid([]byte(spec)) {
		return json.RawMessage(spec), nil
	}
	return json.Marshal(spec)
}

// PolicyPatchSpec sets the spec field on a PolicyPatchBuilder as a JSON object
// rather than a string, ensuring correct serialization for PATCH requests.
func PolicyPatchSpec(b *PolicyPatchBuilder, spec string) *PolicyPatchBuilder {
	if spec == "" {
		return b
	}
	raw, err := SpecAsObject(spec)
	if err != nil {
		b.patch["spec"] = spec
		return b
	}
	var obj any
	if err := json.Unmarshal(raw, &obj); err != nil {
		b.patch["spec"] = spec
		return b
	}
	b.patch["spec"] = obj
	return b
}
