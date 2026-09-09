package sessions

import (
	"crypto/tls"
	"crypto/x509"
	"os"
)

// OpenShift adds this public CA to each service account volume. The system
// roots remain valid for external callback endpoints.
func controlPlaneTLSConfig() *tls.Config {
	roots, err := x509.SystemCertPool()
	if err != nil {
		roots = x509.NewCertPool()
	}
	if data, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt"); err == nil {
		roots.AppendCertsFromPEM(data)
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}
}
