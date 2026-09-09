package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"os"

	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/auth"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/config"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/hypershell"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/keypair"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/kubeclient"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/reconciler"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/tokenserver"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/watcher"
	"github.com/rs/zerolog/log"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

func runHypershellMode(ctx context.Context, cfg *config.ControlPlaneConfig) error {
	managedCfg, err := config.LoadHypershell()
	if err != nil {
		return err
	}
	if cfg.OIDCClientID == "" || cfg.OIDCClientSecret == "" {
		return fmt.Errorf("hypershell runtime requires an authenticated ACP service identity")
	}
	// Kubernetes access is limited to the control plane's own signing key Secret.
	kube, err := kubeclient.New(cfg.Kubeconfig, log.Logger)
	if err != nil {
		return err
	}
	kp, err := keypair.EnsureKeypairSecret(ctx, kube, cfg.CPRuntimeNamespace, log.Logger)
	if err != nil {
		return err
	}
	key, err := keypair.ParsePrivateKey(kp.PrivateKeyPEM)
	if err != nil {
		return err
	}
	cpTokens := buildTokenProvider(cfg, log.Logger)
	hsTokens := auth.NewOIDCTokenProvider(managedCfg.TokenURL, managedCfg.ClientID, managedCfg.ClientSecret, log.Logger)
	hs, err := hypershell.NewClient(managedCfg.APIURL, hsTokens, nil)
	if err != nil {
		return err
	}
	factory := reconciler.NewSDKClientFactory(cfg.APIServerURL, cpTokens, log.Logger)
	runnerCfg := reconciler.KubeReconcilerConfig{RunnerImage: cfg.RunnerImage, OpenShellRunnerImage: cfg.OpenShellRunnerImage, RunnerLogLevel: cfg.RunnerLogLevel, AllowedSandboxRegistries: cfg.AllowedSandboxRegistries, SandboxReadinessTimeoutSeconds: cfg.SandboxReadinessTimeoutSeconds}
	runtime, err := reconciler.NewManagedReconciler(factory, hs, managedCfg, runnerCfg, key, log.Logger)
	if err != nil {
		return err
	}
	gateway := openshell.NewGatewayClient("", 0, nil, "", log.Logger, openshell.WithTargetResolver(runtime.ResolveTarget))
	defer func() {
		if err := gateway.Close(); err != nil {
			log.Warn().Err(err).Msg("close managed gateway connections")
		}
	}()
	runtime.SetGateway(gateway)
	if !cfg.GRPCUseTLS {
		return fmt.Errorf("hypershell runtime requires TLS for the ACP watch connection")
	}
	watchRoots := loadServiceCAPool()
	if managedCfg.CACertFile != "" {
		bundle, err := os.ReadFile(managedCfg.CACertFile)
		if err != nil {
			return fmt.Errorf("read managed watch trust bundle: %w", err)
		}
		if !watchRoots.AppendCertsFromPEM(bundle) {
			return fmt.Errorf("managed watch trust bundle has no certificates")
		}
	}
	conn, err := grpc.NewClient(cfg.GRPCServerAddr, grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12, RootCAs: watchRoots})))
	if err != nil {
		return fmt.Errorf("create ACP watch connection: %w", err)
	}
	defer func() {
		if err := conn.Close(); err != nil {
			log.Warn().Err(err).Msg("close ACP watch connection")
		}
	}()
	watchManager := watcher.NewWatchManager(conn, cpTokens, log.Logger)
	watchManager.RegisterSessionHandler(func(context.Context, watcher.SessionWatchEvent) error { runtime.Notify(); return nil })
	watchManager.RegisterProjectHandler(func(context.Context, watcher.ProjectWatchEvent) error { runtime.Notify(); return nil })

	server, err := tokenserver.New(cfg.CPTokenListenAddr, cpTokens, key, log.Logger, tokenserver.WithGateway(gateway), tokenserver.WithSessionValidator(runtime.ValidateRunner), tokenserver.WithSandboxAuthorizer(runtime.AuthorizeSandbox), tokenserver.WithRunnerAuthorizer(runtime.AuthorizeRunner))
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	errors := make(chan error, 3)
	go watchManager.Run(ctx)
	go func() { errors <- server.Start(ctx) }()
	go func() { errors <- runtime.Run(ctx) }()
	go func() { errors <- reconciler.NewApplicationReconciler(factory, log.Logger).Run(ctx) }()
	log.Info().Str("hypershell_api", managedCfg.APIURL).Str("instance_id", managedCfg.InstanceID).Msg("Hypershell resource backend enabled")
	select {
	case <-ctx.Done():
		return nil
	case err := <-errors:
		return err
	}
}
