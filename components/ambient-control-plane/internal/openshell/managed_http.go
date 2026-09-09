package openshell

import (
	"context"
	"fmt"
	"net"
	"sync"

	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
)

// DialRunner opens only the runner's loopback HTTP port through the authenticated
// gateway. It does not expose a service or accept a caller-selected destination.
func (g *GatewayClient) DialRunner(ctx context.Context, target, sandboxID string) (net.Conn, error) {
	ctx, cancel := context.WithCancel(g.authContext(ctx, target))
	client, err := g.clientForNamespace(ctx, target)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("get runner gateway: %w", err)
	}
	// The pinned gateway requires a sandbox-bound relay token for TCP as well
	// as SSH. Keep it inside the authenticated gateway connection.
	session, err := client.CreateSshSession(ctx, &pb.CreateSshSessionRequest{SandboxId: sandboxID})
	if err != nil {
		cancel()
		return nil, fmt.Errorf("authorize runner connection: %w", err)
	}
	if session.GetToken() == "" {
		cancel()
		return nil, fmt.Errorf("gateway returned no runner relay token")
	}
	stream, err := client.ForwardTcp(ctx)
	if err != nil {
		cancel()
		if g.shouldEvict(err) {
			g.evictConn(target)
		}
		return nil, fmt.Errorf("open runner connection: %w", err)
	}
	err = stream.Send(&pb.TcpForwardFrame{Payload: &pb.TcpForwardFrame_Init{Init: &pb.TcpForwardInit{
		SandboxId: sandboxID, ServiceId: "acp-runner-http", AuthorizationToken: session.GetToken(),
		Target: &pb.TcpForwardInit_Tcp{Tcp: &pb.TcpRelayTarget{Host: "127.0.0.1", Port: 8001}},
	}}})
	if err != nil {
		cancel()
		return nil, fmt.Errorf("initialize runner connection: %w", err)
	}
	return &runnerConn{grpcConn: newGrpcConn(stream), cancel: cancel}, nil
}

type runnerConn struct {
	*grpcConn
	cancel context.CancelFunc
	once   sync.Once
}

func (c *runnerConn) Close() error {
	// Cancel also releases a blocked Recv. CloseSend alone does not do this.
	c.once.Do(c.cancel)
	return nil
}
