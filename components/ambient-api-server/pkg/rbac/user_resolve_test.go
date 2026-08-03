package rbac

import (
	"errors"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func newMockGorm(t *testing.T) (*gorm.DB, sqlmock.Sqlmock) {
	t.Helper()
	sqlDB, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	gormDB, err := gorm.Open(postgres.New(postgres.Config{
		Conn:                 sqlDB,
		PreferSimpleProtocol: true,
	}), &gorm.Config{})
	if err != nil {
		t.Fatalf("gorm.Open: %v", err)
	}
	return gormDB, mock
}

func TestResolveUserID(t *testing.T) {
	tests := []struct {
		name      string
		setup     func(sqlmock.Sqlmock)
		wantID    string
		wantErr   error
		wantAnyErr bool
	}{
		{
			name: "found",
			setup: func(mock sqlmock.Sqlmock) {
				mock.ExpectQuery(`SELECT`).
					WithArgs("alice").
					WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("ksuid_abc123"))
			},
			wantID: "ksuid_abc123",
		},
		{
			name: "not found",
			setup: func(mock sqlmock.Sqlmock) {
				mock.ExpectQuery(`SELECT`).
					WithArgs("ghost").
					WillReturnRows(sqlmock.NewRows([]string{"id"}))
			},
			wantErr: ErrUserNotFound,
		},
		{
			name: "db error",
			setup: func(mock sqlmock.Sqlmock) {
				mock.ExpectQuery(`SELECT`).
					WithArgs("alice").
					WillReturnError(errors.New("connection refused"))
			},
			wantAnyErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gormDB, mock := newMockGorm(t)
			tt.setup(mock)

			username := "alice"
			if tt.wantErr == ErrUserNotFound {
				username = "ghost"
			}

			id, err := ResolveUserID(gormDB, username)

			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Errorf("got err %v, want %v", err, tt.wantErr)
				}
				return
			}
			if tt.wantAnyErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if id != tt.wantID {
				t.Errorf("got id %q, want %q", id, tt.wantID)
			}

			if err := mock.ExpectationsWereMet(); err != nil {
				t.Errorf("unmet sqlmock expectations: %v", err)
			}
		})
	}
}
