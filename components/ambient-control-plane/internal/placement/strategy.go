package placement

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	sdkclient "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/client"
	"github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	"github.com/rs/zerolog"
)

type PlacementRequest struct {
	ProjectID string
	AgentID   string
	Labels    map[string]string
	GatewayID string
}

type PlacementDecision struct {
	ClusterID        string
	GatewayClusterID string
}

type PlacementStrategy interface {
	PlaceSession(ctx context.Context, req PlacementRequest) (PlacementDecision, error)
}

type RoundRobinPlacement struct {
	client             *sdkclient.Client
	heartbeatThreshold time.Duration
	logger             zerolog.Logger
	mu                 sync.Mutex
	gatewayIndex       int
	workloadIndex      int
}

func NewRoundRobinPlacement(client *sdkclient.Client, heartbeatThreshold time.Duration, logger zerolog.Logger) *RoundRobinPlacement {
	return &RoundRobinPlacement{
		client:             client,
		heartbeatThreshold: heartbeatThreshold,
		logger:             logger.With().Str("component", "round-robin-placement").Logger(),
	}
}

func (p *RoundRobinPlacement) PlaceSession(ctx context.Context, req PlacementRequest) (PlacementDecision, error) {
	clusters, err := p.listEligibleClusters(ctx)
	if err != nil {
		return PlacementDecision{}, fmt.Errorf("list eligible clusters: %w", err)
	}

	if len(clusters) == 0 {
		return PlacementDecision{}, fmt.Errorf("no eligible clusters available for placement")
	}

	gatewayClusters := filterByRole(clusters, "gateway", "hybrid")
	workloadClusters := filterByRole(clusters, "workload", "hybrid")

	if len(req.Labels) > 0 {
		workloadClusters = filterByLabels(workloadClusters, req.Labels)
	}

	if len(workloadClusters) == 0 {
		return PlacementDecision{}, fmt.Errorf("no eligible workload clusters match placement constraints")
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	var gatewayClusterID string
	if len(gatewayClusters) > 0 {
		gatewayClusterID = gatewayClusters[p.gatewayIndex%len(gatewayClusters)].ID
		p.gatewayIndex++
	}

	workloadCluster := workloadClusters[p.workloadIndex%len(workloadClusters)]
	p.workloadIndex++

	decision := PlacementDecision{
		ClusterID:        workloadCluster.ID,
		GatewayClusterID: gatewayClusterID,
	}

	p.logger.Info().
		Str("cluster_id", decision.ClusterID).
		Str("gateway_cluster_id", decision.GatewayClusterID).
		Str("project_id", req.ProjectID).
		Msg("session placed")

	return decision, nil
}

func (p *RoundRobinPlacement) listEligibleClusters(ctx context.Context) ([]types.Cluster, error) {
	var all []types.Cluster
	page := 1
	for {
		opts := types.NewListOptions().Page(page).Size(100).Build()
		list, err := p.client.Clusters().List(ctx, opts)
		if err != nil {
			return nil, fmt.Errorf("list clusters page %d: %w", page, err)
		}
		all = append(all, list.Items...)
		if len(all) >= list.Total || len(list.Items) == 0 {
			break
		}
		page++
	}

	cutoff := time.Now().Add(-p.heartbeatThreshold)
	var eligible []types.Cluster
	for _, c := range all {
		if c.Status != "Ready" {
			continue
		}
		if c.LastHeartbeatAt != nil && c.LastHeartbeatAt.Before(cutoff) {
			p.logger.Debug().
				Str("cluster_id", c.ID).
				Str("cluster_name", c.Name).
				Time("last_heartbeat", *c.LastHeartbeatAt).
				Msg("cluster excluded: stale heartbeat")
			continue
		}
		eligible = append(eligible, c)
	}
	return eligible, nil
}

func filterByRole(clusters []types.Cluster, roles ...string) []types.Cluster {
	roleSet := make(map[string]bool, len(roles))
	for _, r := range roles {
		roleSet[r] = true
	}
	var result []types.Cluster
	for _, c := range clusters {
		if roleSet[c.Role] {
			result = append(result, c)
		}
	}
	return result
}

func filterByLabels(clusters []types.Cluster, required map[string]string) []types.Cluster {
	var result []types.Cluster
	for _, c := range clusters {
		if c.Labels == "" {
			continue
		}
		var clusterLabels map[string]string
		if err := json.Unmarshal([]byte(c.Labels), &clusterLabels); err != nil {
			continue
		}
		if matchesLabels(clusterLabels, required) {
			result = append(result, c)
		}
	}
	return result
}

func matchesLabels(have, want map[string]string) bool {
	for k, v := range want {
		if have[k] != v {
			return false
		}
	}
	return true
}
