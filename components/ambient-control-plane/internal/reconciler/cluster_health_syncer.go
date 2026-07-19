package reconciler

import (
	"context"
	"fmt"
	"time"

	sdkclient "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/client"
	"github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	"github.com/rs/zerolog"
)

type ClusterHealthSyncer struct {
	factory  *SDKClientFactory
	interval time.Duration
	logger   zerolog.Logger
}

func NewClusterHealthSyncer(factory *SDKClientFactory, interval time.Duration, logger zerolog.Logger) *ClusterHealthSyncer {
	return &ClusterHealthSyncer{
		factory:  factory,
		interval: interval,
		logger:   logger.With().Str("component", "cluster-health-syncer").Logger(),
	}
}

func (s *ClusterHealthSyncer) Run(ctx context.Context) error {
	s.logger.Info().Dur("interval", s.interval).Msg("cluster health syncer started")
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	s.reconcileOnce(ctx)

	for {
		select {
		case <-ctx.Done():
			s.logger.Info().Msg("cluster health syncer stopped")
			return ctx.Err()
		case <-ticker.C:
			s.reconcileOnce(ctx)
		}
	}
}

func (s *ClusterHealthSyncer) reconcileOnce(ctx context.Context) {
	client, err := s.factory.ForProject(ctx, platformProject)
	if err != nil {
		s.logger.Error().Err(err).Msg("failed to create platform-scoped SDK client")
		return
	}

	clusters, err := s.listAllClusters(ctx, client)
	if err != nil {
		s.logger.Error().Err(err).Msg("failed to list clusters")
		return
	}

	if len(clusters) == 0 {
		s.logger.Debug().Msg("no clusters registered")
		return
	}

	s.logger.Debug().Int("count", len(clusters)).Msg("probing cluster health")

	var readyCount, notReadyCount int
	for _, cluster := range clusters {
		resp, heartbeatErr := client.Clusters().Heartbeat(ctx, cluster.ID)
		if heartbeatErr != nil {
			s.logger.Warn().Err(heartbeatErr).
				Str("cluster_id", cluster.ID).
				Str("cluster_name", cluster.Name).
				Msg("heartbeat failed")
			notReadyCount++
			continue
		}

		if resp.Status == "Ready" {
			readyCount++
		} else {
			notReadyCount++
		}

		s.logger.Debug().
			Str("cluster_id", cluster.ID).
			Str("cluster_name", cluster.Name).
			Str("status", resp.Status).
			Str("capacity", resp.Capacity).
			Msg("heartbeat completed")
	}

	s.logger.Info().
		Int("total", len(clusters)).
		Int("ready", readyCount).
		Int("not_ready", notReadyCount).
		Msg("cluster health check completed")
}

func (s *ClusterHealthSyncer) listAllClusters(ctx context.Context, client *sdkclient.Client) ([]types.Cluster, error) {
	var all []types.Cluster
	page := 1
	for {
		opts := types.NewListOptions().Page(page).Size(100).Build()
		list, err := client.Clusters().List(ctx, opts)
		if err != nil {
			return nil, fmt.Errorf("list clusters page %d: %w", page, err)
		}
		all = append(all, list.Items...)
		if len(all) >= list.Total || len(list.Items) == 0 {
			break
		}
		page++
	}
	return all, nil
}
