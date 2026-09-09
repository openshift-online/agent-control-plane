package sessions

import (
	"context"
	"errors"
	"testing"

	"github.com/openshift-online/rh-trex-ai/pkg/api"
	errorsapi "github.com/openshift-online/rh-trex-ai/pkg/errors"
	"github.com/openshift-online/rh-trex-ai/pkg/services"
)

type inheritanceDAO struct {
	SessionDao
	lookupError error
	created     bool
}

func (d *inheritanceDAO) AgentModel(context.Context, string, string) (string, error) {
	return "agent-model", d.lookupError
}

func (d *inheritanceDAO) Create(_ context.Context, session *Session) (*Session, error) {
	d.created = true
	return session, nil
}

type inheritanceEvents struct{ services.EventService }

func (inheritanceEvents) Create(_ context.Context, event *api.Event) (*api.Event, *errorsapi.ServiceError) {
	return event, nil
}

func TestSessionModelLookupFailureDoesNotCreate(t *testing.T) {
	project, agent := "project", "agent"
	dao := &inheritanceDAO{lookupError: errors.New("database unavailable")}
	svc := NewSessionService(nil, dao, inheritanceEvents{})
	if _, err := svc.Create(context.Background(), &Session{ProjectId: &project, AgentId: &agent}); err == nil {
		t.Fatal("lookup failure must propagate")
	}
	if dao.created {
		t.Fatal("lookup failure created a session with a different model")
	}
	model := "explicit-model"
	created, err := svc.Create(context.Background(), &Session{ProjectId: &project, AgentId: &agent, LlmModel: &model})
	if err != nil || !dao.created || created.LlmModel == nil || *created.LlmModel != model {
		t.Fatalf("explicit override must not depend on model lookup: %v", err)
	}
}
