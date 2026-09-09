package reconciler

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell"
	sandboxpb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/sandbox/v1"
	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	"github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/types"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

const managedKubeconfigPath = "/sandbox/.config/acp/kubeconfig"

func configureManagedGoogleCloud(provider *managedProvider, credential managedCredential) error {
	var source struct {
		ProjectID      string `json:"project_id"`
		ClientEmail    string `json:"client_email"`
		QuotaProjectID string `json:"quota_project_id"`
	}
	if json.Unmarshal([]byte(credential.Token), &source) != nil {
		return fmt.Errorf("invalid configuration: Google credential must contain service-account or ADC JSON")
	}
	kind, err := openshell.DetectGoogleCredentialType(credential.Token)
	if err != nil {
		return fmt.Errorf("unsupported Google credential format")
	}
	provider.data.Type = "google-cloud"
	provider.inference = false
	provider.data.Credentials = map[string]string{}
	provider.refresh = &pb.ConfigureProviderRefreshRequest{Provider: provider.data.Metadata.Name}
	if source.ProjectID == "" {
		source.ProjectID = source.QuotaProjectID
	}
	if source.ProjectID != "" {
		provider.data.Config["GCP_PROJECT_ID"] = source.ProjectID
		provider.env["GOOGLE_CLOUD_PROJECT"] = source.ProjectID
	}
	if source.ClientEmail != "" {
		provider.data.Config["GCP_SERVICE_ACCOUNT_EMAIL"] = source.ClientEmail
	}
	switch kind {
	case openshell.GoogleCredentialServiceAccount:
		material, err := openshell.ExtractServiceAccountJWTMaterial(credential.Token)
		if err != nil {
			return fmt.Errorf("invalid Google service account material")
		}
		provider.refresh.CredentialKey = "GCP_SA_ACCESS_TOKEN"
		provider.refresh.Strategy = pb.ProviderCredentialRefreshStrategy_PROVIDER_CREDENTIAL_REFRESH_STRATEGY_GOOGLE_SERVICE_ACCOUNT_JWT
		provider.refresh.Material = map[string]string{"client_email": material.ClientEmail, "private_key": material.PrivateKey}
		provider.refresh.SecretMaterialKeys = []string{"private_key"}
	case openshell.GoogleCredentialAuthorizedUser:
		material, err := openshell.ExtractOAuth2RefreshMaterial(credential.Token)
		if err != nil {
			return fmt.Errorf("invalid Google ADC refresh material")
		}
		provider.refresh.CredentialKey = "GCP_ADC_ACCESS_TOKEN"
		provider.refresh.Strategy = pb.ProviderCredentialRefreshStrategy_PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_REFRESH_TOKEN
		provider.refresh.Material = map[string]string{"client_id": material.ClientID, "client_secret": material.ClientSecret, "refresh_token": material.RefreshToken}
		provider.refresh.SecretMaterialKeys = []string{"client_secret", "refresh_token"}
	}
	return nil
}

func configureManagedKubeconfig(provider *managedProvider, session types.Session, credential managedCredential) error {
	config, err := clientcmd.Load([]byte(credential.Token))
	if err != nil {
		return fmt.Errorf("kubeconfig credential is not valid YAML or JSON")
	}
	current := config.Contexts[config.CurrentContext]
	if current == nil {
		return fmt.Errorf("kubeconfig requires a valid current-context")
	}
	cluster, identity := config.Clusters[current.Cluster], config.AuthInfos[current.AuthInfo]
	if cluster == nil || identity == nil {
		return fmt.Errorf("kubeconfig current-context requires a cluster and user")
	}
	if identity.Exec != nil || identity.AuthProvider != nil || identity.ClientKey != "" || len(identity.ClientKeyData) > 0 || identity.ClientCertificate != "" || len(identity.ClientCertificateData) > 0 || identity.TokenFile != "" || identity.Username != "" || identity.Password != "" || identity.Impersonate != "" || len(identity.ImpersonateGroups) > 0 || len(identity.ImpersonateUserExtra) > 0 || identity.Token == "" {
		return fmt.Errorf("managed kubeconfig requires an embedded bearer token; exec, mTLS, file references, basic auth, and impersonation are not supported")
	}
	if cluster.InsecureSkipTLSVerify || cluster.ProxyURL != "" || cluster.CertificateAuthority != "" || cluster.TLSServerName != "" {
		return fmt.Errorf("managed kubeconfig requires verified HTTPS without proxy, TLS name override, or CA file references")
	}
	endpoint, err := url.Parse(cluster.Server)
	if err != nil || endpoint.Scheme != "https" || endpoint.Hostname() == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || (endpoint.Path != "" && endpoint.Path != "/") {
		return fmt.Errorf("kubeconfig server must be an HTTPS origin")
	}
	if len(cluster.CertificateAuthorityData) > 0 {
		bundlePath := os.Getenv("HYPERSHELL_KUBERNETES_TRUST_BUNDLE")
		bundle, err := os.ReadFile(bundlePath)
		if err != nil || !containsApprovedCAs(bundle, cluster.CertificateAuthorityData) {
			return fmt.Errorf("kubeconfig CA is not in HYPERSHELL_KUBERNETES_TRUST_BUNDLE; mount the same public CA bundle in the supervisor system trust store")
		}
	}
	port := uint64(443)
	if endpoint.Port() != "" {
		port, err = strconv.ParseUint(endpoint.Port(), 10, 16)
		if err != nil || port == 0 {
			return fmt.Errorf("invalid Kubernetes API port")
		}
	}
	allowedIPs := []string{}
	for _, entry := range strings.Split(os.Getenv("HYPERSHELL_KUBERNETES_ALLOWED_CIDRS"), ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if _, err := netip.ParsePrefix(entry); err != nil {
			if _, err := netip.ParseAddr(entry); err != nil {
				return fmt.Errorf("invalid HYPERSHELL_KUBERNETES_ALLOWED_CIDRS")
			}
		}
		allowedIPs = append(allowedIPs, entry)
	}
	if session.GatewayWorkspace == "" {
		return fmt.Errorf("invalid configuration: Kubernetes provider requires a session gateway workspace")
	}
	profileID := provider.data.Metadata.Name + "-kube"
	provider.profile = &pb.ProviderProfile{Id: profileID, DisplayName: "ACP Kubernetes", Description: "Bound Kubernetes API bearer credential", Category: pb.ProviderProfileCategory_PROVIDER_PROFILE_CATEGORY_OTHER, Annotations: map[string]string{managedSessionAnnotation: session.ID}, Credentials: []*pb.ProviderProfileCredential{{Name: "api_token", EnvVars: []string{"KUBERNETES_TOKEN"}, Required: true, AuthStyle: "bearer", HeaderName: "authorization"}}, Endpoints: []*sandboxpb.NetworkEndpoint{{Host: endpoint.Hostname(), Port: uint32(port), Protocol: "rest", Tls: "terminate", Enforcement: "enforce", Access: "read-write", AllowedIps: allowedIPs}}, Binaries: []*sandboxpb.NetworkBinary{{Path: "/usr/bin/kubectl"}, {Path: "/usr/local/bin/kubectl"}, {Path: "/usr/bin/oc"}, {Path: "/usr/local/bin/oc"}, {Path: "/usr/bin/python3"}, {Path: "/usr/bin/python3.12"}, {Path: "/usr/local/bin/python3"}}, Discovery: &pb.ProviderProfileDiscovery{Credentials: []string{"api_token"}}}
	provider.data.Type = profileID
	provider.data.ProfileWorkspace = session.GatewayWorkspace
	provider.data.Credentials = map[string]string{"KUBERNETES_TOKEN": identity.Token}
	clean := clientcmdapi.Config{Kind: "Config", APIVersion: "v1", CurrentContext: "ambient", Clusters: map[string]*clientcmdapi.Cluster{"ambient": {Server: cluster.Server}}, AuthInfos: map[string]*clientcmdapi.AuthInfo{"ambient": {Token: "openshell:resolve:env:KUBERNETES_TOKEN"}}, Contexts: map[string]*clientcmdapi.Context{"ambient": {Cluster: "ambient", AuthInfo: "ambient", Namespace: current.Namespace}}}
	content, err := clientcmd.Write(clean)
	if err != nil {
		return fmt.Errorf("write sandbox kubeconfig")
	}
	provider.payloads = []openshell.Payload{{Path: managedKubeconfigPath, Content: string(content)}}
	provider.env["KUBECONFIG"] = managedKubeconfigPath
	return nil
}

func containsApprovedCAs(bundle, requested []byte) bool {
	approved := [][]byte{}
	for len(bundle) > 0 {
		block, rest := pem.Decode(bundle)
		if block == nil {
			break
		}
		bundle = rest
		if block.Type == "CERTIFICATE" {
			if _, err := x509.ParseCertificate(block.Bytes); err == nil {
				approved = append(approved, block.Bytes)
			}
		}
	}
	count := 0
	for len(requested) > 0 {
		block, rest := pem.Decode(requested)
		if block == nil {
			return false
		}
		requested = bytes.TrimSpace(rest)
		if block.Type != "CERTIFICATE" {
			return false
		}
		if _, err := x509.ParseCertificate(block.Bytes); err != nil {
			return false
		}
		found := false
		for _, cert := range approved {
			if bytes.Equal(cert, block.Bytes) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
		count++
	}
	return count > 0
}

func reconcileManagedProfile(ctx context.Context, gateway managedProviderGateway, target string, desired *pb.ProviderProfile) error {
	if desired == nil {
		return nil
	}
	response, err := gateway.GetProviderProfile(ctx, target, &pb.GetProviderProfileRequest{Id: desired.Id})
	if status.Code(err) == codes.NotFound {
		result, err := gateway.ImportProviderProfiles(ctx, target, &pb.ImportProviderProfilesRequest{Profiles: []*pb.ProviderProfileImportItem{{Profile: desired}}})
		if err != nil {
			return fmt.Errorf("import Kubernetes provider profile: %s", status.Code(err))
		}
		if !result.GetImported() {
			return fmt.Errorf("gateway rejected Kubernetes provider profile")
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("read Kubernetes provider profile: %s", status.Code(err))
	}
	current := response.GetProfile()
	if current == nil || current.GetAnnotations()[managedSessionAnnotation] != desired.GetAnnotations()[managedSessionAnnotation] {
		return fmt.Errorf("invalid configuration: Kubernetes provider profile ownership does not match session")
	}
	normalized := proto.Clone(current).(*pb.ProviderProfile)
	normalized.ResourceVersion = 0
	normalized.Source = ""
	normalized.Scope = ""
	if proto.Equal(normalized, desired) {
		return nil
	}
	if current.ResourceVersion == 0 {
		return fmt.Errorf("invalid configuration: Kubernetes provider profile has no resource version")
	}
	result, err := gateway.UpdateProviderProfiles(ctx, target, &pb.UpdateProviderProfilesRequest{Id: desired.Id, ExpectedResourceVersion: current.ResourceVersion, Profile: &pb.ProviderProfileImportItem{Profile: desired}})
	if err != nil {
		return fmt.Errorf("update Kubernetes provider profile: %s", status.Code(err))
	}
	if !result.GetUpdated() {
		return fmt.Errorf("gateway rejected Kubernetes provider profile update")
	}
	return nil
}
