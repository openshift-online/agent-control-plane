package gateways_test

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/ambient-code/platform/components/ambient-api-server/plugins/gateways"
	"github.com/openshift-online/rh-trex-ai/pkg/environments"
)

func newGateway(id string) (*gateways.Gateway, error) {
	gatewayService := gateways.Service(&environments.Environment().Services)

	dnsNames := []string{"openshell-gateway.test.svc.cluster.local"}
	dnsNamesJSON, _ := json.Marshal(dnsNames)
	dnsNamesStr := string(dnsNamesJSON)

	gw := &gateways.Gateway{
		Name:           fmt.Sprintf("openshell-gateway-%s", id),
		ProjectId:      "test-project",
		Image:          stringPtr("ghcr.io/nvidia/openshell:v0.0.70"),
		ServerDnsNames: &dnsNamesStr,
		Config:         stringPtr("[openshell.gateway]\nbind_address = \"0.0.0.0:8080\""),
	}

	sub, err := gatewayService.Create(context.Background(), gw)
	if err != nil {
		return nil, err
	}

	return sub, nil
}

func newGatewayList(namePrefix string, count int) ([]*gateways.Gateway, error) {
	var items []*gateways.Gateway
	for i := 1; i <= count; i++ {
		name := fmt.Sprintf("%s_%d", namePrefix, i)
		c, err := newGateway(name)
		if err != nil {
			return nil, err
		}
		items = append(items, c)
	}
	return items, nil
}

func stringPtr(s string) *string { return &s }
