package openshell

import (
	"archive/tar"
	"context"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	pb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"golang.org/x/crypto/ssh"
)

var validPayloadPath = regexp.MustCompile(`^/[a-zA-Z0-9/_.\-]+$`)

type Payload struct {
	Path    string
	Content string
	RepoURL string
	Ref     string
}

func (g *GatewayClient) UploadPayloads(ctx context.Context, namespace string, sandboxID string, payloads []Payload) error {
	ctx = g.authContext(ctx)
	client, err := g.clientForNamespace(ctx, namespace)
	if err != nil {
		return fmt.Errorf("get gateway client: %w", err)
	}

	sshResp, err := client.CreateSshSession(ctx, &pb.CreateSshSessionRequest{SandboxId: sandboxID})
	if err != nil {
		if g.shouldEvict(err) {
			g.evictConn(namespace)
		}
		return fmt.Errorf("create SSH session: %w", err)
	}

	stream, err := client.ForwardTcp(ctx)
	if err != nil {
		if g.shouldEvict(err) {
			g.evictConn(namespace)
		}
		return fmt.Errorf("open ForwardTcp stream: %w", err)
	}

	initFrame := &pb.TcpForwardFrame{
		Payload: &pb.TcpForwardFrame_Init{
			Init: &pb.TcpForwardInit{
				SandboxId:          sandboxID,
				ServiceId:          fmt.Sprintf("payload-upload:%s", sandboxID),
				Target:             &pb.TcpForwardInit_Ssh{Ssh: &pb.SshRelayTarget{}},
				AuthorizationToken: sshResp.Token,
			},
		},
	}
	if err := stream.Send(initFrame); err != nil {
		return fmt.Errorf("send ForwardTcp init: %w", err)
	}

	conn := newGrpcConn(stream)
	defer conn.Close()

	sshConn, chans, reqs, err := ssh.NewClientConn(conn, "sandbox", &ssh.ClientConfig{
		User: "sandbox",
		Auth: []ssh.AuthMethod{ssh.Password("")},
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			if fp := sshResp.HostKeyFingerprint; fp != "" {
				actual := ssh.FingerprintSHA256(key)
				if actual != fp {
					return fmt.Errorf("SSH host key mismatch: got %s, want %s", actual, fp)
				}
			}
			// fp empty → accept (ephemeral key not pinned by gateway); gRPC mTLS +
			// time-limited session token is the outer security boundary.
			return nil
		},
		Timeout: 30 * time.Second,
	})
	if err != nil {
		return fmt.Errorf("SSH handshake: %w", err)
	}
	sshClient := ssh.NewClient(sshConn, chans, reqs)
	defer sshClient.Close()

	for _, p := range payloads {
		if p.RepoURL != "" {
			if err := uploadRepoPayload(ctx, sshClient, p); err != nil {
				return fmt.Errorf("upload repo payload %s: %w", p.Path, err)
			}
		} else {
			if err := writePayloadViaSSH(sshClient, p); err != nil {
				return fmt.Errorf("write payload %s: %w", p.Path, err)
			}
		}
	}
	return nil
}

func validatePayloadPath(path string) error {
	if path == "" {
		return fmt.Errorf("empty path")
	}
	if !validPayloadPath.MatchString(path) {
		return fmt.Errorf("path contains invalid characters: %q", path)
	}
	if strings.Contains(path, "..") {
		return fmt.Errorf("path contains directory traversal: %q", path)
	}
	return nil
}

func writePayloadViaSSH(client *ssh.Client, p Payload) error {
	if err := validatePayloadPath(p.Path); err != nil {
		return fmt.Errorf("invalid payload path: %w", err)
	}

	session, err := client.NewSession()
	if err != nil {
		return fmt.Errorf("open SSH session: %w", err)
	}
	defer session.Close()

	dir := filepath.Dir(p.Path)
	cmd := fmt.Sprintf("mkdir -p '%s' && cat > '%s'", dir, p.Path)

	stdin, err := session.StdinPipe()
	if err != nil {
		return fmt.Errorf("stdin pipe: %w", err)
	}

	var stderrBuf strings.Builder
	session.Stderr = &stderrBuf

	if err := session.Start(cmd); err != nil {
		return fmt.Errorf("start command: %w", err)
	}

	if _, err := io.WriteString(stdin, p.Content); err != nil {
		return fmt.Errorf("write content: %w", err)
	}
	stdin.Close()

	if err := session.Wait(); err != nil {
		stderr := strings.TrimSpace(stderrBuf.String())
		if stderr != "" {
			return fmt.Errorf("command failed (stderr: %s): %w", stderr, err)
		}
		return fmt.Errorf("command failed: %w", err)
	}
	return nil
}

func validateRepoURL(repoURL string) error {
	parsed, err := url.Parse(repoURL)
	if err != nil {
		return fmt.Errorf("invalid repo URL: %w", err)
	}
	if parsed.Scheme != "https" {
		return fmt.Errorf("repo URL must use https:// scheme, got %q", parsed.Scheme)
	}
	if parsed.Host == "" {
		return fmt.Errorf("repo URL missing host")
	}
	return nil
}

func cloneRepo(ctx context.Context, repoURL, ref string) (string, error) {
	if err := validateRepoURL(repoURL); err != nil {
		return "", err
	}

	tmpDir, err := os.MkdirTemp("", "payload-clone-*")
	if err != nil {
		return "", fmt.Errorf("create temp dir: %w", err)
	}

	cloneOpts := &git.CloneOptions{
		URL:   repoURL,
		Depth: 1,
	}

	if ref != "" {
		cloneOpts.ReferenceName = plumbing.NewBranchReferenceName(ref)
		cloneOpts.SingleBranch = true
	}

	var mkErr error
	repo, err := git.PlainCloneContext(ctx, tmpDir, false, cloneOpts)
	if err != nil && ref != "" {
		// Branch ref failed — clean up and retry as tag
		os.RemoveAll(tmpDir)
		tmpDir, mkErr = os.MkdirTemp("", "payload-clone-*")
		if mkErr != nil {
			return "", fmt.Errorf("create temp dir for tag retry: %w", mkErr)
		}
		cloneOpts.ReferenceName = plumbing.NewTagReferenceName(ref)
		repo, err = git.PlainCloneContext(ctx, tmpDir, false, cloneOpts)

		if err != nil && isHexSHA(ref) {
			// Tag ref also failed and ref looks like a SHA — full clone + checkout
			os.RemoveAll(tmpDir)
			tmpDir, mkErr = os.MkdirTemp("", "payload-clone-*")
			if mkErr != nil {
				return "", fmt.Errorf("create temp dir for SHA retry: %w", mkErr)
			}
			cloneOpts.ReferenceName = ""
			cloneOpts.SingleBranch = false
			cloneOpts.Depth = 0
			repo, err = git.PlainCloneContext(ctx, tmpDir, false, cloneOpts)
			if err == nil {
				wt, wtErr := repo.Worktree()
				if wtErr != nil {
					os.RemoveAll(tmpDir)
					return "", fmt.Errorf("get worktree: %w", wtErr)
				}
				if checkoutErr := wt.Checkout(&git.CheckoutOptions{
					Hash: plumbing.NewHash(ref),
				}); checkoutErr != nil {
					os.RemoveAll(tmpDir)
					return "", fmt.Errorf("checkout ref %q: %w", ref, checkoutErr)
				}
			}
		}
	}

	if err != nil {
		os.RemoveAll(tmpDir)
		return "", fmt.Errorf("clone %q (ref=%q): %w", repoURL, ref, err)
	}

	return tmpDir, nil
}

func isHexSHA(s string) bool {
	if len(s) != 40 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func tarDirectory(dir string) io.ReadCloser {
	pr, pw := io.Pipe()
	go func() {
		tw := tar.NewWriter(pw)
		err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			relPath, err := filepath.Rel(dir, path)
			if err != nil {
				return err
			}
			if relPath == "." {
				return nil
			}
			// Skip .git directory
			if d.IsDir() && d.Name() == ".git" {
				return filepath.SkipDir
			}

			info, err := d.Info()
			if err != nil {
				return err
			}

			header, err := tar.FileInfoHeader(info, "")
			if err != nil {
				return err
			}
			header.Name = relPath

			if info.Mode()&fs.ModeSymlink != 0 {
				target, err := os.Readlink(path)
				if err != nil {
					return err
				}
				header.Linkname = target
			}

			if err := tw.WriteHeader(header); err != nil {
				return err
			}

			if !d.IsDir() && info.Mode().IsRegular() {
				if err := copyFileToTar(tw, path); err != nil {
					return err
				}
			}
			return nil
		})
		tw.Close()
		pw.CloseWithError(err)
	}()
	return pr
}

func copyFileToTar(tw *tar.Writer, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(tw, f)
	return err
}

func writeRepoPayloadViaSSH(client *ssh.Client, targetPath string, tarReader io.Reader) error {
	if err := validatePayloadPath(targetPath); err != nil {
		return fmt.Errorf("invalid payload path: %w", err)
	}

	session, err := client.NewSession()
	if err != nil {
		return fmt.Errorf("open SSH session: %w", err)
	}
	defer session.Close()

	cmd := fmt.Sprintf("mkdir -p '%s' && tar xf - -C '%s'", targetPath, targetPath)

	stdin, err := session.StdinPipe()
	if err != nil {
		return fmt.Errorf("stdin pipe: %w", err)
	}

	var stderrBuf strings.Builder
	session.Stderr = &stderrBuf

	if err := session.Start(cmd); err != nil {
		return fmt.Errorf("start command: %w", err)
	}

	if _, err := io.Copy(stdin, tarReader); err != nil {
		return fmt.Errorf("stream tar content: %w", err)
	}
	stdin.Close()

	if err := session.Wait(); err != nil {
		stderr := strings.TrimSpace(stderrBuf.String())
		if stderr != "" {
			return fmt.Errorf("tar extraction failed (stderr: %s): %w", stderr, err)
		}
		return fmt.Errorf("tar extraction failed: %w", err)
	}
	return nil
}

func uploadRepoPayload(ctx context.Context, client *ssh.Client, p Payload) error {
	tmpDir, err := cloneRepo(ctx, p.RepoURL, p.Ref)
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmpDir)

	tarReader := tarDirectory(tmpDir)
	defer tarReader.Close()
	return writeRepoPayloadViaSSH(client, p.Path, tarReader)
}

type grpcConn struct {
	stream pb.OpenShell_ForwardTcpClient
	mu     sync.Mutex
	buf    []byte
}

func newGrpcConn(stream pb.OpenShell_ForwardTcpClient) *grpcConn {
	return &grpcConn{stream: stream}
}

func (c *grpcConn) Read(b []byte) (int, error) {
	if len(c.buf) > 0 {
		n := copy(b, c.buf)
		c.buf = c.buf[n:]
		return n, nil
	}

	frame, err := c.stream.Recv()
	if err != nil {
		return 0, err
	}

	data := frame.GetData()
	if data == nil {
		return 0, nil
	}

	n := copy(b, data)
	if n < len(data) {
		c.buf = data[n:]
	}
	return n, nil
}

func (c *grpcConn) Write(b []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	err := c.stream.Send(&pb.TcpForwardFrame{
		Payload: &pb.TcpForwardFrame_Data{Data: b},
	})
	if err != nil {
		return 0, err
	}
	return len(b), nil
}

func (c *grpcConn) Close() error {
	return c.stream.CloseSend()
}

func (c *grpcConn) LocalAddr() net.Addr                { return stubAddr{} }
func (c *grpcConn) RemoteAddr() net.Addr               { return stubAddr{} }
func (c *grpcConn) SetDeadline(_ time.Time) error      { return nil }
func (c *grpcConn) SetReadDeadline(_ time.Time) error  { return nil }
func (c *grpcConn) SetWriteDeadline(_ time.Time) error { return nil }

type stubAddr struct{}

func (stubAddr) Network() string { return "grpc" }
func (stubAddr) String() string  { return "grpc-forward-tcp" }
