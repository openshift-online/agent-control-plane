package openshell

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"sync"

	"github.com/ambient-code/platform/components/ambient-control-plane/internal/kubeclient"
	"github.com/rs/zerolog"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
)

type TLSResolver struct {
	kube       *kubeclient.KubeClient
	secretName string
	serverName string
	logger     zerolog.Logger

	mu    sync.RWMutex
	cache map[string]credentials.TransportCredentials
}

func NewTLSResolver(kube *kubeclient.KubeClient, secretName string, serverName string, logger zerolog.Logger) *TLSResolver {
	return &TLSResolver{
		kube:       kube,
		secretName: secretName,
		serverName: serverName,
		logger:     logger.With().Str("component", "openshell-tls").Logger(),
		cache:      make(map[string]credentials.TransportCredentials),
	}
}

func (r *TLSResolver) CredentialsForNamespace(ctx context.Context, namespace string) (credentials.TransportCredentials, error) {
	r.mu.RLock()
	creds, ok := r.cache[namespace]
	r.mu.RUnlock()
	if ok {
		return creds, nil
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if creds, ok := r.cache[namespace]; ok {
		return creds, nil
	}

	secret, err := r.kube.GetSecret(ctx, namespace, r.secretName)
	if err != nil {
		return nil, fmt.Errorf("reading TLS secret %s/%s: %w", namespace, r.secretName, err)
	}

	data, ok := secret.Object["data"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("TLS secret %s/%s has no data field", namespace, r.secretName)
	}

	certPEM, err := decodeSecretField(data, "tls.crt")
	if err != nil {
		return nil, fmt.Errorf("reading tls.crt from %s/%s: %w", namespace, r.secretName, err)
	}
	keyPEM, err := decodeSecretField(data, "tls.key")
	if err != nil {
		return nil, fmt.Errorf("reading tls.key from %s/%s: %w", namespace, r.secretName, err)
	}
	caPEM, err := decodeSecretField(data, "ca.crt")
	if err != nil {
		return nil, fmt.Errorf("reading ca.crt from %s/%s: %w", namespace, r.secretName, err)
	}

	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("parsing client certificate from %s/%s: %w", namespace, r.secretName, err)
	}

	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("failed to parse CA certificate from %s/%s", namespace, r.secretName)
	}

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{cert},
		RootCAs:      caPool,
		MinVersion:   tls.VersionTLS12,
		ServerName:   r.serverName,
	}

	creds = credentials.NewTLS(tlsConfig)
	r.cache[namespace] = creds
	r.logger.Info().Str("namespace", namespace).Str("secret", r.secretName).Msg("loaded TLS credentials")
	return creds, nil
}

func (r *TLSResolver) Evict(namespace string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.cache, namespace)
	r.logger.Info().Str("namespace", namespace).Msg("evicted cached TLS credentials")
}

func decodeSecretField(data map[string]interface{}, key string) ([]byte, error) {
	val, ok := data[key]
	if !ok {
		return nil, fmt.Errorf("field %q not found", key)
	}
	s, ok := val.(string)
	if !ok {
		return nil, fmt.Errorf("field %q is not a string", key)
	}
	decoded, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("base64-decoding field %q: %w", key, err)
	}
	return decoded, nil
}

func InsecureResolver() func(ctx context.Context, namespace string) (credentials.TransportCredentials, error) {
	creds := insecure.NewCredentials()
	return func(_ context.Context, _ string) (credentials.TransportCredentials, error) {
		return creds, nil
	}
}
