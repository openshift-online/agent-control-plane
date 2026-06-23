package rbac

import (
	"testing"
)

func TestValidateTSLValues(t *testing.T) {
	tests := []struct {
		name    string
		values  []string
		wantErr bool
	}{
		{name: "simple username", values: []string{"john"}, wantErr: false},
		{name: "email-style username", values: []string{"john@redhat.com"}, wantErr: false},
		{name: "username with dot", values: []string{"john.sell"}, wantErr: false},
		{name: "username with dash", values: []string{"john-sell"}, wantErr: false},
		{name: "username with underscore", values: []string{"john_sell"}, wantErr: false},
		{name: "username with space", values: []string{"varun rao"}, wantErr: false},
		{name: "username with multiple spaces", values: []string{"varun rao kadaparthi"}, wantErr: false},
		{name: "KSUID", values: []string{"3FEf0iXAzwzSG18NGMyX9cYp95p"}, wantErr: false},
		{name: "multiple valid values", values: []string{"proj1", "proj2", "proj3"}, wantErr: false},

		{name: "single quote injection", values: []string{"test' OR 1=1"}, wantErr: true},
		{name: "double quote injection", values: []string{`test" OR 1=1`}, wantErr: true},
		{name: "semicolon injection", values: []string{"test; DROP TABLE"}, wantErr: true},
		{name: "percent wildcard", values: []string{"test%"}, wantErr: true},
		{name: "backslash injection", values: []string{`test\`}, wantErr: true},
		{name: "parentheses", values: []string{"test()"}, wantErr: true},
		{name: "empty string", values: []string{""}, wantErr: true},
		{name: "one valid one invalid", values: []string{"valid", "invalid'"}, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateTSLValues(tt.values)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateTSLValues(%v) error = %v, wantErr %v", tt.values, err, tt.wantErr)
			}
		})
	}
}

func TestTSLEqual(t *testing.T) {
	tests := []struct {
		name    string
		column  string
		value   string
		want    string
		wantErr bool
	}{
		{name: "simple value", column: "user_id", value: "john", want: "user_id = 'john'"},
		{name: "value with space", column: "user_id", value: "varun rao", want: "user_id = 'varun rao'"},
		{name: "injection attempt", column: "user_id", value: "test' OR 1=1", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := TSLEqual(tt.column, tt.value)
			if (err != nil) != tt.wantErr {
				t.Errorf("TSLEqual() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if !tt.wantErr && got != tt.want {
				t.Errorf("TSLEqual() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestTSLIn(t *testing.T) {
	tests := []struct {
		name    string
		column  string
		values  []string
		want    string
		wantErr bool
	}{
		{name: "single value", column: "project_id", values: []string{"proj1"}, want: "project_id in ('proj1')"},
		{name: "multiple values", column: "project_id", values: []string{"proj1", "proj2"}, want: "project_id in ('proj1','proj2')"},
		{name: "value with space", column: "user_id", values: []string{"varun rao"}, want: "user_id in ('varun rao')"},
		{name: "empty slice", column: "id", values: []string{}, wantErr: true},
		{name: "injection in values", column: "id", values: []string{"valid", "bad'"}, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := TSLIn(tt.column, tt.values)
			if (err != nil) != tt.wantErr {
				t.Errorf("TSLIn() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if !tt.wantErr && got != tt.want {
				t.Errorf("TSLIn() = %q, want %q", got, tt.want)
			}
		})
	}
}
