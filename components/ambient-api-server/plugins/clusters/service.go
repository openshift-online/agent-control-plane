package clusters

import (
	"context"

	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
	"github.com/openshift-online/rh-trex-ai/pkg/errors"
	"github.com/openshift-online/rh-trex-ai/pkg/logger"
	"github.com/openshift-online/rh-trex-ai/pkg/services"
)

const ClustersLockType db.LockType = "clusters"

var (
	DisableAdvisoryLock     = false
	UseBlockingAdvisoryLock = true
)

var validRoles = map[string]bool{
	"gateway":  true,
	"workload": true,
	"hybrid":   true,
}

type ClusterService interface {
	Get(ctx context.Context, id string) (*Cluster, *errors.ServiceError)
	Create(ctx context.Context, cluster *Cluster) (*Cluster, *errors.ServiceError)
	Replace(ctx context.Context, cluster *Cluster) (*Cluster, *errors.ServiceError)
	Delete(ctx context.Context, id string) *errors.ServiceError
	All(ctx context.Context) (ClusterList, *errors.ServiceError)
	FindByIDs(ctx context.Context, ids []string) (ClusterList, *errors.ServiceError)

	OnUpsert(ctx context.Context, id string) error
	OnDelete(ctx context.Context, id string) error
}

type ActiveSessionCounter interface {
	CountActiveSessionsOnCluster(ctx context.Context, clusterID string) (int64, error)
}

func NewClusterService(lockFactory db.LockFactory, clusterDao ClusterDao, events services.EventService, sessionCounter ActiveSessionCounter) ClusterService {
	return &sqlClusterService{
		lockFactory:    lockFactory,
		clusterDao:     clusterDao,
		events:         events,
		sessionCounter: sessionCounter,
	}
}

var _ ClusterService = &sqlClusterService{}

type sqlClusterService struct {
	lockFactory    db.LockFactory
	clusterDao     ClusterDao
	events         services.EventService
	sessionCounter ActiveSessionCounter
}

func (s *sqlClusterService) OnUpsert(ctx context.Context, id string) error {
	log := logger.NewLogger(ctx)
	cluster, err := s.clusterDao.Get(ctx, id)
	if err != nil {
		return err
	}
	log.Infof("Cluster upserted: %s (role=%s, status=%s)", cluster.ID, cluster.Role, cluster.Status)
	return nil
}

func (s *sqlClusterService) OnDelete(ctx context.Context, id string) error {
	log := logger.NewLogger(ctx)
	log.Infof("Cluster deleted: %s", id)
	return nil
}

func (s *sqlClusterService) Get(ctx context.Context, id string) (*Cluster, *errors.ServiceError) {
	cluster, err := s.clusterDao.Get(ctx, id)
	if err != nil {
		return nil, services.HandleGetError("Cluster", "id", id, err)
	}
	return cluster, nil
}

func (s *sqlClusterService) Create(ctx context.Context, cluster *Cluster) (*Cluster, *errors.ServiceError) {
	if !validRoles[cluster.Role] {
		return nil, errors.Validation("invalid cluster role: must be gateway, workload, or hybrid")
	}

	cluster.Status = "Unknown"

	cluster, err := s.clusterDao.Create(ctx, cluster)
	if err != nil {
		return nil, services.HandleCreateError("Cluster", err)
	}

	_, evErr := s.events.Create(ctx, &api.Event{
		Source:    "Clusters",
		SourceID:  cluster.ID,
		EventType: api.CreateEventType,
	})
	if evErr != nil {
		return nil, services.HandleCreateError("Cluster", evErr)
	}

	return cluster, nil
}

func (s *sqlClusterService) Replace(ctx context.Context, cluster *Cluster) (*Cluster, *errors.ServiceError) {
	if !DisableAdvisoryLock {
		if UseBlockingAdvisoryLock {
			lockOwnerID, err := s.lockFactory.NewAdvisoryLock(ctx, cluster.ID, ClustersLockType)
			if err != nil {
				return nil, errors.DatabaseAdvisoryLock(err)
			}
			defer s.lockFactory.Unlock(ctx, lockOwnerID)
		} else {
			lockOwnerID, locked, err := s.lockFactory.NewNonBlockingLock(ctx, cluster.ID, ClustersLockType)
			if err != nil {
				return nil, errors.DatabaseAdvisoryLock(err)
			}
			if !locked {
				return nil, services.HandleCreateError("Cluster", errors.New(errors.ErrorConflict, "row locked"))
			}
			defer s.lockFactory.Unlock(ctx, lockOwnerID)
		}
	}

	cluster, err := s.clusterDao.Replace(ctx, cluster)
	if err != nil {
		return nil, services.HandleUpdateError("Cluster", err)
	}

	_, evErr := s.events.Create(ctx, &api.Event{
		Source:    "Clusters",
		SourceID:  cluster.ID,
		EventType: api.UpdateEventType,
	})
	if evErr != nil {
		return nil, services.HandleUpdateError("Cluster", evErr)
	}

	return cluster, nil
}

func (s *sqlClusterService) Delete(ctx context.Context, id string) *errors.ServiceError {
	if s.sessionCounter != nil {
		count, err := s.sessionCounter.CountActiveSessionsOnCluster(ctx, id)
		if err != nil {
			return errors.GeneralError("unable to check active sessions: %v", err)
		}
		if count > 0 {
			return errors.New(errors.ErrorConflict,
				"cannot deregister cluster: %d active session(s) reference this cluster", count)
		}
	}

	if err := s.clusterDao.Delete(ctx, id); err != nil {
		return services.HandleDeleteError("Cluster", errors.GeneralError("unable to delete cluster: %s", err))
	}

	_, evErr := s.events.Create(ctx, &api.Event{
		Source:    "Clusters",
		SourceID:  id,
		EventType: api.DeleteEventType,
	})
	if evErr != nil {
		return services.HandleDeleteError("Cluster", evErr)
	}

	return nil
}

func (s *sqlClusterService) FindByIDs(ctx context.Context, ids []string) (ClusterList, *errors.ServiceError) {
	clusters, err := s.clusterDao.FindByIDs(ctx, ids)
	if err != nil {
		return nil, errors.GeneralError("unable to find clusters: %s", err)
	}
	return clusters, nil
}

func (s *sqlClusterService) All(ctx context.Context) (ClusterList, *errors.ServiceError) {
	clusters, err := s.clusterDao.All(ctx)
	if err != nil {
		return nil, errors.GeneralError("unable to get all clusters: %s", err)
	}
	return clusters, nil
}
