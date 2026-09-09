package credentials

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"gorm.io/gorm"
)

type deleteCredentialDAO struct {
	CredentialDao
	errors []error
}

func (d *deleteCredentialDAO) Delete(context.Context, string) error {
	err := d.errors[0]
	d.errors = d.errors[1:]
	return err
}

func TestDeleteCredentialMissingRecord(t *testing.T) {
	for _, missing := range []error{gorm.ErrRecordNotFound, fmt.Errorf("delete: %w", gorm.ErrRecordNotFound)} {
		dao := &deleteCredentialDAO{errors: []error{nil, missing}}
		service := NewCredentialService(nil, dao, nil, nil, nil)
		if err := service.Delete(context.Background(), "credential-id"); err != nil {
			t.Fatalf("first delete failed: %v", err)
		}
		if err := service.Delete(context.Background(), "credential-id"); err == nil || err.HttpCode != http.StatusNotFound {
			t.Fatalf("repeated delete must return 404, got %v", err)
		}
	}
}

func TestDeleteCredentialDatabaseFailure(t *testing.T) {
	dao := &deleteCredentialDAO{errors: []error{errors.New("database unavailable")}}
	service := NewCredentialService(nil, dao, nil, nil, nil)
	if err := service.Delete(context.Background(), "credential-id"); err == nil || err.HttpCode != http.StatusInternalServerError {
		t.Fatalf("database failure must remain 500, got %v", err)
	}
}
