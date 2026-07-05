package openshell

import (
	"context"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	pb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	"golang.org/x/crypto/ssh"
)

var validPayloadPath = regexp.MustCompile(`^/[a-zA-Z0-9/_.\-]+$`)

type Payload struct {
	Path    string
	Content string
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
		if err := writePayloadViaSSH(sshClient, p); err != nil {
			return fmt.Errorf("write payload %s: %w", p.Path, err)
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
