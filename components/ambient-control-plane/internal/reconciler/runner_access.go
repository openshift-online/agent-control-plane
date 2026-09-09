package reconciler

import (
	"context"
	"fmt"
	sdkclient "github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/client"
)

func checkRunnerAccess(ctx context.Context, baseURL, bearer, sessionID, method, action string) error {
	sdk, err := sdkclient.NewServiceClient(baseURL, bearer)
	if err != nil {
		return fmt.Errorf("runner access denied")
	}
	if err := sdk.Sessions().CheckRunnerAccess(ctx, sessionID, method, action); err != nil {
		return fmt.Errorf("runner access denied")
	}
	return nil
}

func (r *ManagedReconciler) AuthorizeRunner(ctx context.Context, bearer, sessionID, sandboxName, method, action string) (string, error) {
	if err := checkRunnerAccess(ctx, r.factory.BaseURL(), bearer, sessionID, method, action); err != nil {
		return "", err
	}
	return r.AuthorizeSandbox(ctx, bearer, sessionID, sandboxName)
}

func (i *LegacyRunnerIdentity) AuthorizeRunner(ctx context.Context, bearer, sessionID, sandboxName, method, action string) (string, error) {
	if err := checkRunnerAccess(ctx, i.factory.BaseURL(), bearer, sessionID, method, action); err != nil {
		return "", err
	}
	return i.AuthorizeSandbox(ctx, bearer, sessionID, sandboxName)
}
