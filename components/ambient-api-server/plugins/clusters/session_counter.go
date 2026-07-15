package clusters

import (
	"context"
	"strings"

	"github.com/openshift-online/rh-trex-ai/pkg/db"
)

type sessionCounter struct {
	sessionFactory *db.SessionFactory
}

func NewSessionCounter(sessionFactory *db.SessionFactory) ActiveSessionCounter {
	return &sessionCounter{sessionFactory: sessionFactory}
}

func (s *sessionCounter) CountActiveSessionsOnCluster(ctx context.Context, clusterID string) (int64, error) {
	g2 := (*s.sessionFactory).New(ctx)

	var count int64
	err := g2.Table("sessions").
		Where("deleted_at IS NULL").
		Where("phase NOT IN (?)", []string{"Completed", "Failed", "Stopped"}).
		Where("(cluster_id = ? OR gateway_cluster_id = ?)", clusterID, clusterID).
		Count(&count).Error
	if err != nil {
		if isColumnNotFoundError(err) {
			return 0, nil
		}
		return 0, err
	}
	return count, nil
}

func isColumnNotFoundError(err error) bool {
	if err == nil {
		return false
	}
	errStr := err.Error()
	return strings.Contains(errStr, "column") && strings.Contains(errStr, "does not exist")
}
