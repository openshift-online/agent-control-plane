package client

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/types"
)

func (a *SessionAPI) PatchLabels(ctx context.Context, id string, labels map[string]string) (*types.Session, error) {
	b, err := json.Marshal(labels)
	if err != nil {
		return nil, fmt.Errorf("marshal labels: %w", err)
	}
	return a.Update(ctx, id, map[string]any{"labels": string(b)})
}

func (a *SessionAPI) PatchAnnotations(ctx context.Context, id string, annotations map[string]string) (*types.Session, error) {
	b, err := json.Marshal(annotations)
	if err != nil {
		return nil, fmt.Errorf("marshal annotations: %w", err)
	}
	return a.Update(ctx, id, map[string]any{"annotations": string(b)})
}
