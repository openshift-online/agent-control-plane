package tokenserver

import (
	"context"
	"crypto/rsa"
	"crypto/tls"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/auth"
	"github.com/rs/zerolog"
)

const (
	DefaultListenAddr   = ":8080"
	readTimeout         = 10 * time.Second
	writeTimeout        = 10 * time.Second
	idleTimeout         = 60 * time.Second
	shutdownGracePeriod = 5 * time.Second
)

type Server struct {
	srv         *http.Server
	logger      zerolog.Logger
	tlsCertFile string
	tlsKeyFile  string
}

// Option configures optional server behavior.
type Option func(*serverConfig)

type serverConfig struct {
	gateway         SandboxGateway
	validate        SessionValidator
	authorize       SandboxAuthorizer
	authorizeRunner RunnerAuthorizer
}

// WithSessionValidator enables scoped runner token exchange.
func WithSessionValidator(validate SessionValidator) Option {
	return func(c *serverConfig) { c.validate = validate }
}

// WithSandboxAuthorizer verifies a user token and returns its authorized gateway.
func WithSandboxAuthorizer(authorize SandboxAuthorizer) Option {
	return func(c *serverConfig) { c.authorize = authorize }
}

// WithRunnerAuthorizer checks the caller's permission for the runner operation.
func WithRunnerAuthorizer(authorize RunnerAuthorizer) Option {
	return func(c *serverConfig) { c.authorizeRunner = authorize }
}

// WithGateway injects an OpenShell gateway client for sandbox observability endpoints.
func WithGateway(gw SandboxGateway) Option {
	return func(c *serverConfig) { c.gateway = gw }
}

func New(
	listenAddr string,
	tokenProvider auth.TokenProvider,
	privateKey *rsa.PrivateKey,
	logger zerolog.Logger,
	opts ...Option,
) (*Server, error) {
	var cfg serverConfig
	for _, o := range opts {
		o(&cfg)
	}

	certFile, keyFile := os.Getenv("CP_TOKEN_TLS_CERT_FILE"), os.Getenv("CP_TOKEN_TLS_KEY_FILE")
	if (certFile == "") != (keyFile == "") {
		return nil, fmt.Errorf("CP token TLS requires both certificate and key files")
	}
	if certFile != "" {
		if _, err := tls.LoadX509KeyPair(certFile, keyFile); err != nil {
			return nil, fmt.Errorf("load CP token TLS certificate: %w", err)
		}
	}
	componentLogger := logger.With().Str("component", "tokenserver").Logger()

	h := &handler{
		validate:   cfg.validate,
		privateKey: privateKey,
		logger:     componentLogger,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/token", h.handleToken)
	mux.HandleFunc("/healthz", handleHealthz)

	if cfg.gateway != nil {
		sbx := &sandboxHandler{
			gateway:         cfg.gateway,
			logger:          componentLogger,
			authorize:       cfg.authorize,
			authorizeRunner: cfg.authorizeRunner,
		}
		mux.HandleFunc("/sandbox/", func(w http.ResponseWriter, r *http.Request) {
			switch {
			case strings.Contains(r.URL.Path, "/runner/"):
				sbx.handleRunnerProxy(w, r)
			case strings.HasSuffix(r.URL.Path, "/policy"):
				sbx.handlePolicy(w, r)
			case strings.HasSuffix(r.URL.Path, "/logs"):
				sbx.handleLogs(w, r)
			default:
				http.NotFound(w, r)
			}
		})
		componentLogger.Info().Msg("sandbox observability endpoints registered")
	}

	return &Server{
		srv: &http.Server{
			Addr:         listenAddr,
			TLSConfig:    &tls.Config{MinVersion: tls.VersionTLS12},
			Handler:      mux,
			ReadTimeout:  readTimeout,
			WriteTimeout: writeTimeout,
			IdleTimeout:  idleTimeout,
		},
		logger:      componentLogger,
		tlsCertFile: certFile,
		tlsKeyFile:  keyFile,
	}, nil
}

func (s *Server) Start(ctx context.Context) error {
	errCh := make(chan error, 1)
	go func() {
		s.logger.Info().Str("addr", s.srv.Addr).Msg("token server listening")
		var err error
		if s.tlsCertFile != "" {
			err = s.srv.ListenAndServeTLS(s.tlsCertFile, s.tlsKeyFile)
		} else {
			err = s.srv.ListenAndServe()
		}
		if err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGracePeriod)
		defer cancel()
		if err := s.srv.Shutdown(shutdownCtx); err != nil {
			s.logger.Warn().Err(err).Msg("token server shutdown error")
		}
		return nil
	case err := <-errCh:
		return fmt.Errorf("token server: %w", err)
	}
}
