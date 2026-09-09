package projects

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/runtimeapi"
	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type runtimeTestFactory struct {
	db.SessionFactory
	database *gorm.DB
}

func (f runtimeTestFactory) New(ctx context.Context) *gorm.DB { return f.database.WithContext(ctx) }

func TestRuntimeUserWriteCannotReplaceBindingOrUndelete(t *testing.T) {
	matcher := sqlmock.QueryMatcherFunc(func(expected, actual string) error {
		if expected == "update" {
			if !strings.HasPrefix(actual, "UPDATE") || !strings.Contains(actual, "runtime_version = $") || !strings.Contains(actual, `"deleted_at" IS NULL`) {
				return fmt.Errorf("missing guarded update: %s", actual)
			}
			if !strings.Contains(actual, "COALESCE(runtime_backend") || !strings.Contains(actual, "COALESCE(gateway_id") || !strings.Contains(actual, "OR name = $") {
				return fmt.Errorf("missing bound identity guard: %s", actual)
			}
			assignments := strings.Split(actual, " WHERE ")[0]
			for _, field := range []string{"runtime_version", "gateway_id", "runtime_backend", "gateway_credential_id", "deleted_at"} {
				if strings.Contains(assignments, `"`+field+`"=`) {
					return fmt.Errorf("user update writes runtime field: %s", field)
				}
			}
			return nil
		}
		if !strings.HasPrefix(actual, "SELECT") {
			return fmt.Errorf("unexpected SQL: %s", actual)
		}
		return nil
	})
	sqlDB, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(matcher))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		mock.ExpectClose()
		if err := sqlDB.Close(); err != nil {
			t.Errorf("close mock database: %v", err)
		}
	}()
	database, err := gorm.Open(postgres.New(postgres.Config{Conn: sqlDB}), &gorm.Config{DisableAutomaticPing: true, SkipDefaultTransaction: true})
	if err != nil {
		t.Fatal(err)
	}
	var factory db.SessionFactory = runtimeTestFactory{database: database}
	dao := NewProjectDao(&factory)
	gateway := "old-gateway"
	row := &Project{Meta: api.Meta{ID: "resource-a"}, Name: "Resource", RuntimeVersion: 3, GatewayId: &gateway}
	mock.ExpectExec("update").WillReturnResult(sqlmock.NewResult(0, 1))
	if _, err := dao.Replace(context.Background(), row); err != nil {
		t.Fatal(err)
	}
	mock.ExpectExec("update").WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery("select").WillReturnRows(sqlmock.NewRows([]string{"id", "runtime_version"}).AddRow("resource-a", 4))
	if _, err := dao.Replace(context.Background(), row); !errors.Is(err, runtimeapi.ErrConflict) {
		t.Fatalf("stale write: %v", err)
	}
	mock.ExpectExec("update").WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery("select").WillReturnRows(sqlmock.NewRows([]string{"id"}))
	if _, err := dao.Replace(context.Background(), row); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("deleted row update: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
