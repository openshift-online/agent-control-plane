package reconciler

import (
	"context"
	"os"
	"strings"
	"testing"

	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

func (g *managedFakeGateway) GetProviderProfile(ctx context.Context, target string, r *pb.GetProviderProfileRequest) (*pb.ProviderProfileResponse, error) {
	g.scope(target)
	p := g.profiles[r.Id]
	if p == nil {
		return nil, status.Error(codes.NotFound, "missing")
	}
	return &pb.ProviderProfileResponse{Profile: proto.Clone(p).(*pb.ProviderProfile)}, nil
}
func (g *managedFakeGateway) ImportProviderProfiles(ctx context.Context, target string, r *pb.ImportProviderProfilesRequest) (*pb.ImportProviderProfilesResponse, error) {
	g.scope(target)
	if g.profiles == nil {
		g.profiles = map[string]*pb.ProviderProfile{}
	}
	for _, item := range r.Profiles {
		p := proto.Clone(item.Profile).(*pb.ProviderProfile)
		p.ResourceVersion = 1
		g.profiles[p.Id] = p
	}
	g.operations = append(g.operations, "profile-import")
	return &pb.ImportProviderProfilesResponse{Imported: true}, nil
}
func (g *managedFakeGateway) UpdateProviderProfiles(ctx context.Context, target string, r *pb.UpdateProviderProfilesRequest) (*pb.UpdateProviderProfilesResponse, error) {
	g.scope(target)
	if g.profiles[r.Id].ResourceVersion != r.ExpectedResourceVersion {
		return nil, status.Error(codes.Aborted, "stale")
	}
	p := proto.Clone(r.Profile.Profile).(*pb.ProviderProfile)
	p.ResourceVersion = r.ExpectedResourceVersion + 1
	g.profiles[r.Id] = p
	g.operations = append(g.operations, "profile-update")
	return &pb.UpdateProviderProfilesResponse{Updated: true, Profile: p}, nil
}
func managedTestKubeconfig() *clientcmdapi.Config {
	return &clientcmdapi.Config{CurrentContext: "selected", Clusters: map[string]*clientcmdapi.Cluster{"cluster": {Server: "https://kube.example:6443"}}, AuthInfos: map[string]*clientcmdapi.AuthInfo{"user": {Token: "private-test-bearer"}}, Contexts: map[string]*clientcmdapi.Context{"selected": {Cluster: "cluster", AuthInfo: "user", Namespace: "ns"}}}
}
func TestManagedKubeconfigPayloadAndProfile(t *testing.T) {
	t.Setenv("HYPERSHELL_KUBERNETES_ALLOWED_CIDRS", "10.0.0.0/8")
	source := managedTestKubeconfig()
	raw, err := clientcmd.Write(*source)
	if err != nil {
		t.Fatal(err)
	}
	c := managedTestCredential("kubeconfig")
	c.Token = string(raw)
	s := managedTestSession()
	s.GatewayWorkspace = "session-workspace"
	p, err := buildManagedProvider(s, nil, c)
	if err != nil {
		t.Fatal(err)
	}
	if p.data.Credentials["KUBERNETES_TOKEN"] != source.AuthInfos["user"].Token || p.data.ProfileWorkspace != s.GatewayWorkspace {
		t.Fatal("credential or workspace mapping lost")
	}
	if len(p.payloads) != 1 || strings.Contains(p.payloads[0].Content, "private-test-bearer") {
		t.Fatal("secret leaked into payload")
	}
	clean, err := clientcmd.Load([]byte(p.payloads[0].Content))
	if err != nil {
		t.Fatal(err)
	}
	if clean.AuthInfos["ambient"].Token != "openshell:resolve:env:KUBERNETES_TOKEN" || clean.Clusters["ambient"].InsecureSkipTLSVerify || len(clean.Clusters["ambient"].CertificateAuthorityData) != 0 {
		t.Fatal("unsafe sandbox kubeconfig")
	}
	if p.profile.Endpoints[0].Host != "kube.example" || p.profile.Endpoints[0].Port != 6443 || p.profile.Endpoints[0].Tls != "terminate" || p.profile.Endpoints[0].AllowedIps[0] != "10.0.0.0/8" {
		t.Fatal("wrong API policy")
	}
	g := &managedFakeGateway{}
	ctx := context.Background()
	if err := reconcileManagedProfile(ctx, g, "target", p.profile); err != nil {
		t.Fatal(err)
	}
	if err := reconcileManagedProfile(ctx, g, "target", p.profile); err != nil {
		t.Fatal(err)
	}
	if len(g.operations) != 1 {
		t.Fatal("unchanged profile rewritten")
	}
	p.profile.Endpoints[0].Port = 443
	if err := reconcileManagedProfile(ctx, g, "target", p.profile); err != nil {
		t.Fatal(err)
	}
	if g.profiles[p.profile.Id].ResourceVersion != 2 {
		t.Fatal("profile CAS not used")
	}
	g.profiles[p.profile.Id].Annotations[managedSessionAnnotation] = "other-session"
	if err := reconcileManagedProfile(ctx, g, "target", p.profile); err == nil {
		t.Fatal("cross-session profile accepted")
	}
}
func TestManagedKubeconfigRejectsUnsafeFormats(t *testing.T) {
	cases := map[string]func(*clientcmdapi.Config){
		"exec":          func(c *clientcmdapi.Config) { c.AuthInfos["user"].Exec = &clientcmdapi.ExecConfig{Command: "steal"} },
		"mtls":          func(c *clientcmdapi.Config) { c.AuthInfos["user"].ClientKeyData = []byte("key") },
		"token-file":    func(c *clientcmdapi.Config) { c.AuthInfos["user"].TokenFile = "/secret" },
		"insecure":      func(c *clientcmdapi.Config) { c.Clusters["cluster"].InsecureSkipTLSVerify = true },
		"ca-file":       func(c *clientcmdapi.Config) { c.Clusters["cluster"].CertificateAuthority = "/secret" },
		"unapproved-ca": func(c *clientcmdapi.Config) { c.Clusters["cluster"].CertificateAuthorityData = []byte("not-approved") },
		"http":          func(c *clientcmdapi.Config) { c.Clusters["cluster"].Server = "http://kube.example" },
		"impersonate":   func(c *clientcmdapi.Config) { c.AuthInfos["user"].Impersonate = "admin" },
	}
	for name, modify := range cases {
		t.Run(name, func(t *testing.T) {
			source := managedTestKubeconfig()
			modify(source)
			raw, err := clientcmd.Write(*source)
			if err != nil {
				t.Fatal(err)
			}
			c := managedTestCredential("kubeconfig")
			c.Token = string(raw)
			s := managedTestSession()
			s.GatewayWorkspace = "workspace"
			if _, err := buildManagedProvider(s, nil, c); err == nil {
				t.Fatal("unsafe format accepted")
			}
		})
	}
}
func TestManagedNativeGoogleProfile(t *testing.T) {
	c := managedTestCredential("google")
	c.Token = `{"type":"authorized_user","client_id":"client","client_secret":"secret","refresh_token":"refresh","quota_project_id":"project"}`
	p, err := buildManagedProvider(managedTestSession(), nil, c)
	if err != nil {
		t.Fatal(err)
	}
	if p.inference || p.data.Type != "google-cloud" || p.refresh.CredentialKey != "GCP_ADC_ACCESS_TOKEN" || p.data.Config["GCP_PROJECT_ID"] != "project" {
		t.Fatal("native Google refresh not configured")
	}
	if len(p.payloads) != 0 || len(p.data.Credentials) != 0 {
		t.Fatal("Google secret emitted as payload or static credential")
	}
	for _, v := range p.env {
		if strings.Contains(v, "secret") || strings.Contains(v, "refresh") {
			t.Fatal("Google material in environment")
		}
	}
}
func TestManagedApprovedTrustBundle(t *testing.T) {
	// Use a public system CA to test exact certificate membership.
	data, err := os.ReadFile("/etc/ssl/certs/ca-certificates.crt")
	if err != nil {
		t.Skip("system CA bundle unavailable")
	}
	if !containsApprovedCAs(data, data) {
		t.Fatal("valid approved bundle rejected")
	}
	if containsApprovedCAs(data, []byte("invalid")) {
		t.Fatal("invalid CA accepted")
	}
}
