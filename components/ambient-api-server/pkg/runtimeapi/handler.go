// Package runtimeapi implements service-only runtime inventory and compare-and-swap writes.
package runtimeapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/golang/glog"
	"github.com/gorilla/mux"
	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/middleware"
	"github.com/openshift-online/rh-trex-ai/pkg/auth"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrConflict = errors.New("runtime version or phase changed")

type FieldKind int

const (
	String FieldKind = iota
	Timestamp
)

type Patch struct {
	Version       int64
	ExpectedPhase *string
	Fields        map[string]interface{}
}

// Store must retain tombstones and must never insert on a failed update.
type Store[T interface{}] interface {
	List(context.Context, int, int) ([]*T, int64, error)
	Patch(context.Context, string, Patch) (*T, error)
}

type Handler[T interface{}, R interface{}] struct {
	Store   Store[T]
	Present func(*T) R
	Fields  map[string]FieldKind
}

func RequireService(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if !middleware.IsServiceCaller(ctx) {
			payload, err := auth.GetAuthPayloadFromContext(ctx)
			if err != nil || payload == nil || !middleware.IsConfiguredServiceAccount(payload.Username) {
				http.Error(w, "runtime API requires a service identity", http.StatusForbidden)
				return
			}
			ctx = middleware.WithCallerType(ctx, middleware.CallerTypeService)
		}
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (h Handler[T, R]) List(w http.ResponseWriter, r *http.Request) {
	if !middleware.IsServiceCaller(r.Context()) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	page, size := 1, 100
	var err error
	if value := r.URL.Query().Get("page"); value != "" {
		page, err = strconv.Atoi(value)
		if err != nil {
			http.Error(w, "invalid page", 400)
			return
		}
	}
	if value := r.URL.Query().Get("size"); value != "" {
		size, err = strconv.Atoi(value)
		if err != nil {
			http.Error(w, "invalid size", 400)
			return
		}
	}
	if page < 1 || size < 1 || size > 500 || page > 1000000/size+1 {
		http.Error(w, "page or size out of range", 400)
		return
	}
	rows, total, err := h.Store.List(r.Context(), (page-1)*size, size)
	if err != nil {
		http.Error(w, "runtime inventory unavailable", http.StatusInternalServerError)
		return
	}
	items := make([]R, 0, len(rows))
	for _, row := range rows {
		items = append(items, h.Present(row))
	}
	writeJSON(w, map[string]interface{}{"items": items, "total": total, "page": page, "size": size})
}

func (h Handler[T, R]) Patch(w http.ResponseWriter, r *http.Request) {
	if !middleware.IsServiceCaller(r.Context()) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	patch, err := DecodePatch(http.MaxBytesReader(w, r.Body, 65536), h.Fields)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	row, err := h.Store.Patch(r.Context(), mux.Vars(r)["id"], patch)
	if errors.Is(err, ErrConflict) {
		http.Error(w, "runtime state changed; read it again", http.StatusConflict)
		return
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		http.Error(w, "resource not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "runtime update failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, h.Present(row))
}

func DecodePatch(reader io.Reader, allowed map[string]FieldKind) (Patch, error) {
	patch := Patch{Fields: map[string]interface{}{}}
	var raw map[string]json.RawMessage
	decoder := json.NewDecoder(reader)
	if err := decoder.Decode(&raw); err != nil {
		return patch, fmt.Errorf("invalid runtime patch")
	}
	var extra interface{}
	if err := decoder.Decode(&extra); err != io.EOF {
		return patch, fmt.Errorf("one JSON object is required")
	}
	version, present := raw["runtime_version"]
	if !present || string(version) == "null" || json.Unmarshal(version, &patch.Version) != nil || patch.Version < 0 {
		return patch, fmt.Errorf("runtime_version must be a nonnegative integer")
	}
	delete(raw, "runtime_version")
	if value, ok := raw["expected_phase"]; ok {
		var phase string
		if string(value) == "null" || json.Unmarshal(value, &phase) != nil {
			return patch, fmt.Errorf("expected_phase must be a string")
		}
		patch.ExpectedPhase = &phase
		delete(raw, "expected_phase")
	}
	for field, value := range raw {
		kind, ok := allowed[field]
		if !ok {
			return patch, fmt.Errorf("field is not a runtime field")
		}
		if string(value) == "null" {
			patch.Fields[field] = nil
			continue
		}
		var text string
		if json.Unmarshal(value, &text) != nil {
			return patch, fmt.Errorf("runtime fields must be strings or null")
		}
		if len(text) > 16384 {
			return patch, fmt.Errorf("runtime field is too long")
		}
		if kind == Timestamp {
			parsed, err := time.Parse(time.RFC3339Nano, text)
			if err != nil {
				return patch, fmt.Errorf("invalid runtime timestamp")
			}
			patch.Fields[field] = parsed
		} else {
			patch.Fields[field] = text
		}
	}
	if len(patch.Fields) == 0 {
		return patch, fmt.Errorf("runtime patch has no fields")
	}
	for _, field := range []string{"phase", "start_time", "completion_time"} {
		if _, ok := patch.Fields[field]; ok && patch.ExpectedPhase == nil {
			return patch, fmt.Errorf("expected_phase is required for lifecycle changes")
		}
	}
	return patch, nil
}

func writeJSON(w http.ResponseWriter, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		glog.Warning("Could not write runtime API response")
	}
}

type SQLStore[T interface{}] struct {
	NewDB       func(context.Context) *gorm.DB
	AfterUpdate func(context.Context, *T) error
}

func (s SQLStore[T]) List(ctx context.Context, offset, size int) ([]*T, int64, error) {
	var rows []*T
	var total int64
	query := s.NewDB(ctx).Unscoped().Model(new(T))
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if err := query.Order("id ASC").Offset(offset).Limit(size).Find(&rows).Error; err != nil {
		return nil, 0, err
	}
	return rows, total, nil
}
func (s SQLStore[T]) Patch(ctx context.Context, id string, p Patch) (*T, error) {
	var row T
	query := s.NewDB(ctx).Unscoped().Model(&row).Where("id = ? AND runtime_version = ?", id, p.Version)
	if p.ExpectedPhase != nil {
		query = query.Where("COALESCE(phase, '') = ?", *p.ExpectedPhase)
	}
	fields := make(map[string]interface{}, len(p.Fields)+2)
	for k, v := range p.Fields {
		fields[k] = v
	}
	fields["runtime_version"] = gorm.Expr("runtime_version + 1")
	fields["updated_at"] = time.Now().UTC()
	result := query.Clauses(clause.Returning{}).Updates(fields)
	if result.Error != nil {
		db.MarkForRollback(ctx, result.Error)
		return nil, result.Error
	}
	if result.RowsAffected == 0 {
		var existing T
		if err := s.NewDB(ctx).Unscoped().Take(&existing, "id = ?", id).Error; err != nil {
			return nil, err
		}
		return nil, ErrConflict
	}
	if s.AfterUpdate != nil {
		if err := s.AfterUpdate(ctx, &row); err != nil {
			db.MarkForRollback(ctx, err)
			return nil, err
		}
	}
	return &row, nil
}
