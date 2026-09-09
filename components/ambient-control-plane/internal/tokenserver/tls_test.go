package tokenserver

import (
	"testing"

	"github.com/rs/zerolog"
)

func TestTokenServerTLSFailsClosed(t *testing.T) {
	t.Setenv("CP_TOKEN_TLS_CERT_FILE", "missing-cert")
	t.Setenv("CP_TOKEN_TLS_KEY_FILE", "")
	if _, err := New(":0", nil, nil, zerolog.Nop()); err == nil {
		t.Fatal("partial TLS configuration accepted")
	}
	t.Setenv("CP_TOKEN_TLS_KEY_FILE", "missing-key")
	if _, err := New(":0", nil, nil, zerolog.Nop()); err == nil {
		t.Fatal("missing certificate accepted")
	}
	t.Setenv("CP_TOKEN_TLS_CERT_FILE", "")
	t.Setenv("CP_TOKEN_TLS_KEY_FILE", "")
	if _, err := New(":0", nil, nil, zerolog.Nop()); err != nil {
		t.Fatal(err)
	}
}
