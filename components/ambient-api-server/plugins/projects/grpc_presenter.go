package projects

import (
	pb "github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/api/grpc/ambient/v1"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func projectToProto(p *Project) *pb.Project {
	if p == nil {
		return nil
	}

	return &pb.Project{
		RuntimeBackend:           p.RuntimeBackend,
		GatewayId:                p.GatewayId,
		GatewayInstanceId:        p.GatewayInstanceId,
		GatewayEndpoint:          p.GatewayEndpoint,
		GatewayStatus:            p.GatewayStatus,
		GatewayError:             p.GatewayError,
		GatewayCredentialId:      p.GatewayCredentialId,
		GatewayAccountId:         p.GatewayAccountId,
		GatewayAccountExpiresAt:  p.GatewayAccountExpiresAt,
		GatewayExternalReference: p.GatewayExternalReference,
		RuntimeDeleted:           p.DeletedAt.Valid,
		RuntimeVersion:           p.RuntimeVersion,
		Metadata: &pb.ObjectReference{
			Id:        p.ID,
			CreatedAt: timestamppb.New(p.CreatedAt),
			UpdatedAt: timestamppb.New(p.UpdatedAt),
			Kind:      "Project",
			Href:      "/api/ambient/v1/projects/" + p.ID,
		},
		Name:        p.Name,
		Description: p.Description,
		Labels:      p.Labels,
		Annotations: p.Annotations,
		Status:      p.Status,
	}
}
