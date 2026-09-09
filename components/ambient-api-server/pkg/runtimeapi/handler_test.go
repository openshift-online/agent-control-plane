package runtimeapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gorilla/mux"
	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/middleware"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestRuntimeSnapshotSizeLimits(t *testing.T) {
	fields := map[string]FieldKind{"sandbox_logs_snapshot": Snapshot, "sandbox_policy_snapshot": Snapshot, "gateway_id": String}
	for _, tc := range []struct {
		name, field string
		size        int
		valid       bool
	}{
		{"large logs", "sandbox_logs_snapshot", MaxSnapshotBytes, true},
		{"large policy", "sandbox_policy_snapshot", MaxSnapshotBytes, true},
		{"oversize logs", "sandbox_logs_snapshot", MaxSnapshotBytes + 1, false},
		{"oversize policy", "sandbox_policy_snapshot", MaxSnapshotBytes + 1, false},
		{"identity limit retained", "gateway_id", 16385, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			value := `"` + strings.Repeat("x", tc.size-2) + `"`
			body, err := json.Marshal(map[string]interface{}{"runtime_version": 7, tc.field: value})
			if err != nil {
				t.Fatal(err)
			}
			patch, err := DecodePatch(strings.NewReader(string(body)), fields)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%t, error=%v", tc.valid, err)
			}
			if tc.valid && patch.Fields[tc.field] != value {
				t.Fatal("snapshot content changed")
			}
		})
	}
}

func TestRuntimePatchAcceptsEscapedSnapshotsInOneCASWrite(t *testing.T) {
	store := &fakeStore{}
	h := Handler[runtimeRow, *runtimeRow]{Store: store, Present: func(r *runtimeRow) *runtimeRow { return r }, Fields: map[string]FieldKind{"sandbox_logs_snapshot": Snapshot, "sandbox_policy_snapshot": Snapshot}}
	// Escaping inside each JSON document adds another layer in the HTTP body.
	document := `"` + strings.Repeat(`\"`, (MaxSnapshotBytes-2)/2) + `"`
	if !json.Valid([]byte(document)) {
		t.Fatal("test snapshot must be valid JSON")
	}
	body, err := json.Marshal(map[string]interface{}{"runtime_version": 7, "expected_phase": "Stopping", "sandbox_logs_snapshot": document, "sandbox_policy_snapshot": document})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPatch, "/runtime/sessions/session-a", strings.NewReader(string(body)))
	req = mux.SetURLVars(req, map[string]string{"id": "session-a"})
	req = req.WithContext(middleware.WithCallerType(req.Context(), middleware.CallerTypeService))
	out := httptest.NewRecorder()
	h.Patch(out, req)
	if out.Code != http.StatusOK || store.calls != 1 || store.patch.Version != 7 {
		t.Fatalf("snapshot status=%d, writes=%d", out.Code, store.calls)
	}
	if store.patch.Fields["sandbox_logs_snapshot"] != document || store.patch.Fields["sandbox_policy_snapshot"] != document || *store.patch.ExpectedPhase != "Stopping" {
		t.Fatal("snapshot or phase guard changed")
	}
}

type runtimeRow struct {
	ID             string `gorm:"primaryKey"`
	GatewayID      string
	Phase          string
	RuntimeVersion int64
	UpdatedAt      time.Time
	DeletedAt      gorm.DeletedAt
}

func (runtimeRow) TableName() string { return "runtime_rows" }

type fakeStore struct {
	calls int
	err   error
	patch Patch
}

func (s *fakeStore) List(ctx context.Context, offset, size int) ([]*runtimeRow, int64, error) {
	s.calls++
	return []*runtimeRow{}, 0, s.err
}
func (s *fakeStore) Patch(ctx context.Context, id string, p Patch) (*runtimeRow, error) {
	s.calls++
	s.patch = p
	return &runtimeRow{ID: id}, s.err
}

func TestRuntimeRejectsUsersBeforeDatabase(t *testing.T) {
	store := &fakeStore{}
	h := Handler[runtimeRow, *runtimeRow]{Store: store, Present: func(r *runtimeRow) *runtimeRow { return r }, Fields: map[string]FieldKind{"gateway_id": String}}
	for _, method := range []string{http.MethodGet, http.MethodPatch} {
		request := httptest.NewRequest(method, "/runtime/projects", strings.NewReader(`{"runtime_version":0,"gateway_id":"gateway-a"}`))
		output := httptest.NewRecorder()
		if method == http.MethodGet {
			RequireService(http.HandlerFunc(h.List)).ServeHTTP(output, request)
		} else {
			h.Patch(output, request)
		}
		if output.Code != http.StatusForbidden {
			t.Fatalf("user request: %d", output.Code)
		}
	}
	if store.calls != 0 {
		t.Fatal("user request reached database")
	}
}

func TestRuntimePatchValidation(t *testing.T) {
	fields := map[string]FieldKind{"gateway_id": String, "phase": String, "start_time": Timestamp}
	for _, body := range []string{
		`{}`, `null`, `[]`, `{"runtime_version":null,"gateway_id":"a"}`, `{"runtime_version":-1,"gateway_id":"a"}`,
		`{"runtime_version":1.5,"gateway_id":"a"}`, `{"runtime_version":1,"name":"user change"}`,
		`{"runtime_version":1,"deleted_at":null}`, `{"runtime_version":1,"gateway_id":42}`,
		`{"runtime_version":1,"phase":"Running"}`, `{"runtime_version":1,"start_time":"invalid","expected_phase":"Creating"}`,
		`{"runtime_version":1,"gateway_id":"a"} {}`,
	} {
		t.Run(body, func(t *testing.T) {
			if _, err := DecodePatch(strings.NewReader(body), fields); err == nil {
				t.Fatal("invalid patch accepted")
			}
		})
	}
	patch, err := DecodePatch(strings.NewReader(`{"runtime_version":3,"gateway_id":null,"phase":"Running","expected_phase":"Creating","start_time":"2026-09-09T10:00:00Z"}`), fields)
	if err != nil {
		t.Fatal(err)
	}
	if patch.Version != 3 || patch.Fields["gateway_id"] != nil || *patch.ExpectedPhase != "Creating" {
		t.Fatal("patch semantics changed")
	}
	if _, ok := patch.Fields["start_time"].(time.Time); !ok {
		t.Fatal("timestamp not parsed")
	}
}

func TestRuntimeCASConflictStatus(t *testing.T) {
	store := &fakeStore{err: ErrConflict}
	h := Handler[runtimeRow, *runtimeRow]{Store: store, Present: func(r *runtimeRow) *runtimeRow { return r }, Fields: map[string]FieldKind{"gateway_id": String}}
	req := httptest.NewRequest(http.MethodPatch, "/runtime/projects/project-a", strings.NewReader(`{"runtime_version":3,"gateway_id":"gateway-a"}`))
	req = mux.SetURLVars(req, map[string]string{"id": "project-a"})
	req = req.WithContext(middleware.WithCallerType(req.Context(), middleware.CallerTypeService))
	out := httptest.NewRecorder()
	h.Patch(out, req)
	if out.Code != http.StatusConflict || store.calls != 1 {
		t.Fatalf("stale patch: %d", out.Code)
	}
}

func TestRuntimeInventoryPaginationBounds(t *testing.T) {
	store := &fakeStore{}
	h := Handler[runtimeRow, *runtimeRow]{Store: store, Present: func(r *runtimeRow) *runtimeRow { return r }}
	for _, query := range []string{"page=0", "page=-1", "size=0", "size=501", "page=99999999999999999999999", "page=1000000&size=500"} {
		req := httptest.NewRequest(http.MethodGet, "/runtime/projects?"+query, nil)
		req = req.WithContext(middleware.WithCallerType(req.Context(), middleware.CallerTypeService))
		out := httptest.NewRecorder()
		h.List(out, req)
		if out.Code != 400 {
			t.Fatalf("invalid bounds %s: %d", query, out.Code)
		}
	}
	if store.calls != 0 {
		t.Fatal("invalid query reached database")
	}
}

func TestRuntimeSQLCASPreservesTombstones(t *testing.T) {
	match := sqlmock.QueryMatcherFunc(func(expected, actual string) error {
		if expected == "update" {
			for _, part := range []string{`UPDATE "runtime_rows" SET`, `"runtime_version"=runtime_version + 1`, `id = $`, `runtime_version = $`, `COALESCE(phase, '') = $`, `RETURNING *`} {
				if !strings.Contains(actual, part) {
					return fmt.Errorf("missing CAS clause %q in %s", part, actual)
				}
			}
			if strings.Contains(actual, `"deleted_at"=`) || strings.Contains(actual, `"deleted_at" IS NULL`) {
				return fmt.Errorf("tombstone changed or excluded: %s", actual)
			}
			return nil
		}
		if !strings.Contains(actual, "SELECT") || strings.Contains(actual, `"deleted_at" IS NULL`) {
			return fmt.Errorf("unexpected inventory query: %s", actual)
		}
		return nil
	})
	sqlDB, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(match))
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
	store := SQLStore[runtimeRow]{NewDB: func(ctx context.Context) *gorm.DB { return database.WithContext(ctx) }}
	deleted := time.Now().UTC()
	phase := "Creating"
	mock.ExpectQuery("update").WillReturnRows(sqlmock.NewRows([]string{"id", "gateway_id", "phase", "runtime_version", "deleted_at"}).AddRow("session-a", "gateway-a", "Running", 4, deleted))
	row, err := store.Patch(context.Background(), "session-a", Patch{Version: 3, ExpectedPhase: &phase, Fields: map[string]interface{}{"gateway_id": "gateway-a", "phase": "Running"}})
	if err != nil {
		t.Fatal(err)
	}
	if !row.DeletedAt.Valid || row.RuntimeVersion != 4 {
		t.Fatal("tombstone or runtime version lost")
	}
	mock.ExpectQuery("update").WillReturnRows(sqlmock.NewRows([]string{"id"}))
	mock.ExpectQuery("select").WillReturnRows(sqlmock.NewRows([]string{"id", "runtime_version", "deleted_at"}).AddRow("session-a", 4, deleted))
	_, err = store.Patch(context.Background(), "session-a", Patch{Version: 3, ExpectedPhase: &phase, Fields: map[string]interface{}{"phase": "Running"}})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("stale CAS error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
