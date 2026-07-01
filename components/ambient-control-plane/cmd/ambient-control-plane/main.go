package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ambient-code/platform/components/ambient-control-plane/internal/auth"
	"github.com/ambient-code/platform/components/ambient-control-plane/internal/config"
	"github.com/ambient-code/platform/components/ambient-control-plane/internal/gateway"
	"github.com/ambient-code/platform/components/ambient-control-plane/internal/informer"
	"github.com/ambient-code/platform/components/ambient-control-plane/internal/keypair"
	"github.com/ambient-code/platform/components/ambient-control-plane/internal/kubeclient"
	"github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell"
	"github.com/ambient-code/platform/components/ambient-control-plane/internal/reconciler"
	"github.com/ambient-code/platform/components/ambient-control-plane/internal/tokenserver"
	"github.com/ambient-code/platform/components/ambient-control-plane/internal/watcher"
	sdkclient "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/client"
	"github.com/rs/zerolog"

	"github.com/rs/zerolog/log"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	v1 "k8s.io/api/core/v1"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

var (
	version   string
	buildTime string
)

func main() {
	installServiceCAIntoDefaultTransport(loadServiceCAPool())

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	cfg, err := config.Load()
	if err != nil {
		log.Fatal().Err(err).Msg("failed to load configuration")
	}

	level, err := zerolog.ParseLevel(cfg.LogLevel)
	if err != nil {
		level = zerolog.InfoLevel
	}
	zerolog.SetGlobalLevel(level)

	log.Info().
		Str("version", version).
		Str("build_time", buildTime).
		Str("log_level", level.String()).
		Str("mode", cfg.Mode).
		Str("api_server_url", cfg.APIServerURL).
		Str("grpc_server_addr", cfg.GRPCServerAddr).
		Bool("grpc_use_tls", cfg.GRPCUseTLS).
		Msg("ambient-control-plane starting")

	switch cfg.Mode {
	case "kube":
		if err := runKubeMode(ctx, cfg); err != nil {
			log.Fatal().Err(err).Msg("kube mode failed")
		}
	case "test":
		if err := runTestMode(ctx, cfg); err != nil {
			log.Fatal().Err(err).Msg("test mode failed")
		}
	default:
		log.Fatal().Str("mode", cfg.Mode).Msg("unknown mode")
	}
}

func buildTokenProvider(cfg *config.ControlPlaneConfig, logger zerolog.Logger) auth.TokenProvider {
	if cfg.OIDCClientID != "" && cfg.OIDCClientSecret != "" {
		logger.Info().
			Str("token_url", cfg.OIDCTokenURL).
			Str("client_id", cfg.OIDCClientID).
			Msg("using OIDC client credentials token provider")
		return auth.NewOIDCTokenProvider(cfg.OIDCTokenURL, cfg.OIDCClientID, cfg.OIDCClientSecret, logger)
	}
	logger.Info().Msg("using static token provider")
	return auth.NewStaticTokenProvider(cfg.APIToken)
}

func buildNamespaceProvisioner(cfg *config.ControlPlaneConfig, kube *kubeclient.KubeClient) kubeclient.NamespaceProvisioner {
	switch cfg.PlatformMode {
	case "mpp":
		log.Info().Str("config_namespace", cfg.MPPConfigNamespace).Msg("using MPP TenantNamespace provisioner")
		return kubeclient.NewMPPNamespaceProvisioner(kube, cfg.MPPConfigNamespace, log.Logger)
	default:
		log.Info().Msg("using standard Kubernetes namespace provisioner")
		return kubeclient.NewStandardNamespaceProvisioner(kube, log.Logger)
	}
}

func runKubeMode(ctx context.Context, cfg *config.ControlPlaneConfig) error {
	log.Info().Msg("starting in Kubernetes mode")

	kube, err := kubeclient.New(cfg.Kubeconfig, log.Logger)
	if err != nil {
		return fmt.Errorf("creating Kubernetes client: %w", err)
	}

	var projectKube *kubeclient.KubeClient
	if cfg.ProjectKubeTokenFile != "" {
		pk, err := kubeclient.NewFromTokenFile(cfg.ProjectKubeTokenFile, log.Logger)
		if err != nil {
			return fmt.Errorf("creating project Kubernetes client from token file: %w", err)
		}
		projectKube = pk
		log.Info().Str("token_file", cfg.ProjectKubeTokenFile).Msg("using separate project kube client")
	}

	provisionerKube := kube
	if projectKube != nil {
		provisionerKube = projectKube
	}
	provisioner := buildNamespaceProvisioner(cfg, provisionerKube)
	tokenProvider := buildTokenProvider(cfg, log.Logger)

	kp, err := keypair.EnsureKeypairSecret(ctx, provisionerKube, cfg.CPRuntimeNamespace, log.Logger)
	if err != nil {
		return fmt.Errorf("bootstrapping CP token keypair: %w", err)
	}
	log.Info().Str("namespace", cfg.CPRuntimeNamespace).Msg("CP token keypair ready")

	factory := reconciler.NewSDKClientFactory(cfg.APIServerURL, tokenProvider, log.Logger)
	kubeReconcilerCfg := reconciler.KubeReconcilerConfig{
		RunnerImage:              cfg.RunnerImage,
		RunnerGRPCURL:            cfg.GRPCServerAddr,
		RunnerGRPCUseTLS:         cfg.RunnerGRPCUseTLS,
		AnthropicAPIKey:          cfg.AnthropicAPIKey,
		VertexEnabled:            cfg.VertexEnabled,
		VertexProjectID:          cfg.VertexProjectID,
		VertexRegion:             cfg.VertexRegion,
		VertexCredentialsPath:    cfg.VertexCredentialsPath,
		VertexSecretName:         cfg.VertexSecretName,
		VertexSecretNamespace:    cfg.VertexSecretNamespace,
		RunnerImageNamespace:     cfg.RunnerImageNamespace,
		MCPImage:                 cfg.MCPImage,
		MCPAPIServerURL:          cfg.MCPAPIServerURL,
		GitHubMCPImage:           cfg.GitHubMCPImage,
		JiraMCPImage:             cfg.JiraMCPImage,
		K8sMCPImage:              cfg.K8sMCPImage,
		GoogleMCPImage:           cfg.GoogleMCPImage,
		RunnerLogLevel:           cfg.RunnerLogLevel,
		CPRuntimeNamespace:       cfg.CPRuntimeNamespace,
		CPTokenURL:               cfg.CPTokenURL,
		CPTokenPublicKey:         string(kp.PublicKeyPEM),
		HTTPProxy:                cfg.HTTPProxy,
		HTTPSProxy:               cfg.HTTPSProxy,
		NoProxy:                  cfg.NoProxy,
		ImagePullSecret:          cfg.ImagePullSecret,
		PlatformMode:             cfg.PlatformMode,
		MPPConfigNamespace:       cfg.MPPConfigNamespace,
		OpenShellEnabled:         cfg.OpenShellEnabled,
		OpenShellUseGateway:      cfg.OpenShellUseGateway,
		OpenShellRunnerImage:     cfg.OpenShellRunnerImage,
		OpenShellPolicyName:      cfg.OpenShellPolicyName,
		ServiceIdentity:          cfg.ServiceIdentity,
		CACertFile:               cfg.CACertFile,
		AllowedSandboxRegistries: cfg.AllowedSandboxRegistries,
	}

	conn, err := grpc.NewClient(cfg.GRPCServerAddr, grpc.WithTransportCredentials(grpcCredentials(cfg.GRPCUseTLS)))
	if err != nil {
		return fmt.Errorf("connecting to gRPC server: %w", err)
	}
	defer func() {
		if closeErr := conn.Close(); closeErr != nil {
			log.Warn().Err(closeErr).
				Str("grpc_server_addr", cfg.GRPCServerAddr).
				Bool("grpc_use_tls", cfg.GRPCUseTLS).
				Msg("failed to close gRPC connection")
		}
	}()

	watchManager := watcher.NewWatchManager(conn, tokenProvider, log.Logger)

	initToken, err := tokenProvider.Token(ctx)
	if err != nil {
		return fmt.Errorf("resolving initial API token: %w", err)
	}

	sdk, err := sdkclient.NewClient(cfg.APIServerURL, initToken, "default")
	if err != nil {
		return fmt.Errorf("creating SDK client: %w", err)
	}

	inf := informer.New(sdk, watchManager, log.Logger)

	projectReconciler := reconciler.NewProjectReconciler(factory, kube, projectKube, provisioner, cfg.CPRuntimeNamespace, cfg.PlatformMode, log.Logger)
	projectSettingsReconciler := reconciler.NewProjectSettingsReconciler(factory, kube, log.Logger)

	inf.RegisterHandler("projects", projectReconciler.Reconcile)
	inf.RegisterHandler("project_settings", projectSettingsReconciler.Reconcile)

	// Initialize gateway provisioning (if enabled)
	gatewayErrCh := make(chan error, 1)
	if cfg.OpenShellUseGateway {
		go func() {
			gatewayErrCh <- initGatewayProvisioning(ctx, cfg.Kubeconfig, cfg.CPRuntimeNamespace)
		}()
	} else {
		// Close channel immediately so it's never selected
		close(gatewayErrCh)
	}

	var gateway *openshell.GatewayClient
	if cfg.OpenShellUseGateway {
		var resolveCred openshell.CredentialResolver
		if cfg.OpenShellGatewayTLSEnabled {
			tlsResolver := openshell.NewTLSResolver(provisionerKube, cfg.OpenShellGatewayClientTLSSecret, cfg.OpenShellGatewayTLSServerName, log.Logger)
			resolveCred = tlsResolver.CredentialsForNamespace
			log.Info().Str("secret", cfg.OpenShellGatewayClientTLSSecret).Str("server_name", cfg.OpenShellGatewayTLSServerName).Msg("OpenShell gateway TLS enabled")
		} else {
			resolveCred = openshell.InsecureResolver()
			log.Info().Msg("OpenShell gateway TLS disabled (plaintext)")
		}
		gateway = openshell.NewGatewayClient(cfg.OpenShellGatewayServiceName, cfg.OpenShellGatewayGRPCPort, resolveCred, cfg.OpenShellGatewaySATokenPath, log.Logger)
		defer func() {
			if err := gateway.Close(); err != nil {
				log.Warn().Err(err).Msg("failed to close gateway client")
			}
		}()
		log.Info().Msg("OpenShell gateway mode enabled")
	}

	sessionReconcilers := createSessionReconcilers(cfg.Reconcilers, factory, kube, projectKube, provisioner, gateway, kubeReconcilerCfg, log.Logger, inf)
	for _, sessionRec := range sessionReconcilers {
		inf.RegisterHandler("sessions", sessionRec.Reconcile)
	}

	podSyncer := reconciler.NewPodStatusSyncer(factory, provisionerKube, gateway, cfg.OpenShellUseGateway, cfg.PlatformMode, cfg.MPPConfigNamespace, log.Logger)

	tsErrCh := make(chan error, 1)
	go func() {
		tsErrCh <- startTokenServer(ctx, cfg, tokenProvider, kp)
	}()

	infErrCh := make(chan error, 1)
	go func() {
		infErrCh <- inf.Run(ctx)
	}()

	podSyncErrCh := make(chan error, 1)
	go func() {
		podSyncErrCh <- podSyncer.Run(ctx)
	}()

	var cmSyncErrCh <-chan error
	if cfg.OpenShellUseGateway {
		cmSyncer := reconciler.NewConfigMapSyncer(factory, provisionerKube, provisioner, cfg.PlatformMode, cfg.MPPConfigNamespace, log.Logger)
		ch := make(chan error, 1)
		go func() {
			ch <- cmSyncer.Run(ctx)
		}()
		cmSyncErrCh = ch
		log.Info().Msg("ConfigMap agent declaration syncer enabled")
	}

	select {
	case tsErr := <-tsErrCh:
		if tsErr != nil {
			return fmt.Errorf("token server: %w", tsErr)
		}
		return <-infErrCh
	case infErr := <-infErrCh:
		return infErr
	case podSyncErr := <-podSyncErrCh:
		return fmt.Errorf("pod status syncer: %w", podSyncErr)
	case cmSyncErr := <-cmSyncErrCh:
		return fmt.Errorf("configmap syncer: %w", cmSyncErr)
	case gwErr := <-gatewayErrCh:
		if gwErr != nil {
			return fmt.Errorf("gateway provisioning: %w", gwErr)
		}
		return <-infErrCh
	}
}

func startTokenServer(ctx context.Context, cfg *config.ControlPlaneConfig, tokenProvider auth.TokenProvider, kp *keypair.KeyPair) error {
	privKey, err := keypair.ParsePrivateKey(kp.PrivateKeyPEM)
	if err != nil {
		return fmt.Errorf("parsing CP token private key: %w", err)
	}
	ts, err := tokenserver.New(cfg.CPTokenListenAddr, tokenProvider, privKey, log.Logger)
	if err != nil {
		return fmt.Errorf("creating token server: %w", err)
	}
	return ts.Start(ctx)
}

func createSessionReconcilers(reconcilerTypes []string, factory *reconciler.SDKClientFactory, kube *kubeclient.KubeClient, projectKube *kubeclient.KubeClient, provisioner kubeclient.NamespaceProvisioner, gateway *openshell.GatewayClient, cfg reconciler.KubeReconcilerConfig, logger zerolog.Logger, inf *informer.Informer) []reconciler.Reconciler {
	var reconcilers []reconciler.Reconciler

	for _, reconcilerType := range reconcilerTypes {
		switch reconcilerType {
		case "kube":
			kubeReconciler := reconciler.NewKubeReconciler(factory, kube, projectKube, provisioner, gateway, cfg, logger)
			inf.OnMaxRetriesExceeded = kubeReconciler.HandleProvisioningFailure
			reconcilers = append(reconcilers, kubeReconciler)
			log.Info().Str("type", "kube").Msg("enabled direct Kubernetes session reconciler")
		case "tally":
			tallyReconciler := reconciler.NewSessionTallyReconciler(logger)
			reconcilers = append(reconcilers, tallyReconciler)
			log.Info().Str("type", "tally").Msg("enabled session tally reconciler")
		default:
			log.Warn().Str("type", reconcilerType).Msg("unknown reconciler type, skipping")
		}
	}

	if len(reconcilers) == 0 {
		log.Warn().Msg("no valid reconcilers configured, falling back to tally reconciler")
		tallyReconciler := reconciler.NewSessionTallyReconciler(logger)
		reconcilers = append(reconcilers, tallyReconciler)
	}

	log.Info().Int("count", len(reconcilers)).Strs("types", reconcilerTypes).Msg("configured session reconcilers")
	return reconcilers
}

func initGatewayProvisioning(ctx context.Context, kubeconfig string, namespace string) error {
	log.Info().Msg("initializing gateway provisioning")

	// Build REST config
	cfg, err := buildKubeConfig(kubeconfig)
	if err != nil {
		return fmt.Errorf("build kubeconfig: %w", err)
	}

	// Create Kubernetes clientset
	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return fmt.Errorf("create kubernetes clientset: %w", err)
	}

	// Create dynamic client
	dynamicClient, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return fmt.Errorf("create dynamic client: %w", err)
	}

	// Load platform config
	nsConfigs, platformConfigCM, err := gateway.LoadPlatformConfig(ctx, clientset, namespace)
	if err != nil {
		log.Error().Err(err).Msg("failed to load platform config, gateway provisioning disabled")
		nsConfigs = []gateway.NamespaceConfig{} // Continue without gateway provisioning
		platformConfigCM = nil
	}

	// Load gateway manifests
	manifests, err := gateway.LoadGatewayManifests("/manifests/gateway")
	if err != nil {
		return fmt.Errorf("load gateway manifests: %w", err)
	}

	// Initial reconciliation
	if err := gateway.ReconcileGateways(ctx, dynamicClient, clientset, nsConfigs, manifests, platformConfigCM); err != nil {
		log.Error().Err(err).Msg("initial gateway reconciliation failed")
	}

	// Start ConfigMap watcher (blocks until context cancelled)
	return gateway.WatchPlatformConfig(ctx, clientset, namespace, func(newConfigs []gateway.NamespaceConfig, cm *v1.ConfigMap) {
		log.Info().Int("namespaces", len(newConfigs)).Msg("platform-config updated, reconciling gateways")
		if err := gateway.ReconcileGateways(ctx, dynamicClient, clientset, newConfigs, manifests, cm); err != nil {
			log.Error().Err(err).Msg("gateway reconciliation after config update failed")
		}
	})
}

func buildKubeConfig(kubeconfig string) (*rest.Config, error) {
	if kubeconfig != "" {
		return clientcmd.BuildConfigFromFlags("", kubeconfig)
	}
	return rest.InClusterConfig()
}

func loadServiceCAPool() *x509.CertPool {
	pool, err := x509.SystemCertPool()
	if err != nil {
		pool = x509.NewCertPool()
	}
	if ca, readErr := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt"); readErr == nil {
		pool.AppendCertsFromPEM(ca)
	}
	return pool
}

func installServiceCAIntoDefaultTransport(pool *x509.CertPool) {
	http.DefaultTransport = &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			RootCAs:    pool,
		},
	}
}

func grpcCredentials(useTLS bool) credentials.TransportCredentials {
	if !useTLS {
		return insecure.NewCredentials()
	}
	return credentials.NewTLS(&tls.Config{
		MinVersion: tls.VersionTLS12,
		RootCAs:    loadServiceCAPool(),
	})
}

func runTestMode(ctx context.Context, cfg *config.ControlPlaneConfig) error {
	log.Info().Msg("starting in test mode")

	tokenProvider := buildTokenProvider(cfg, log.Logger)
	initToken, err := tokenProvider.Token(ctx)
	if err != nil {
		return fmt.Errorf("resolving API token: %w", err)
	}

	sdk, err := sdkclient.NewClient(cfg.APIServerURL, initToken, "default")
	if err != nil {
		return fmt.Errorf("creating SDK client: %w", err)
	}

	conn, err := grpc.NewClient(cfg.GRPCServerAddr, grpc.WithTransportCredentials(grpcCredentials(cfg.GRPCUseTLS)))
	if err != nil {
		return fmt.Errorf("connecting to gRPC server: %w", err)
	}
	defer func() {
		if closeErr := conn.Close(); closeErr != nil {
			log.Warn().Err(closeErr).
				Str("grpc_server_addr", cfg.GRPCServerAddr).
				Bool("grpc_use_tls", cfg.GRPCUseTLS).
				Msg("failed to close gRPC connection")
		}
	}()

	watchManager := watcher.NewWatchManager(conn, tokenProvider, log.Logger)
	inf := informer.New(sdk, watchManager, log.Logger)

	tallyReconciler := reconciler.NewTallyReconciler("sessions", sdk, log.Logger)
	inf.RegisterHandler("sessions", tallyReconciler.Reconcile)

	return inf.Run(ctx)
}
