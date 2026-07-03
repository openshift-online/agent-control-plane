package sessions

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/golang/glog"
	"github.com/gorilla/mux"
)

type eventHandler struct {
	session SessionService
	evt     EventService
}

func NewEventHandler(session SessionService, evt EventService) *eventHandler {
	return &eventHandler{session: session, evt: evt}
}

func (h *eventHandler) ListEvents(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := mux.Vars(r)["id"]

	if _, err := h.session.Get(ctx, id); err != nil {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	opts := EventListOptions{
		Limit: 100,
	}

	if v := r.URL.Query().Get("after_seq"); v != "" {
		if parsed, err := strconv.ParseInt(v, 10, 64); err == nil {
			opts.AfterSeq = parsed
		}
	}
	if v := r.URL.Query().Get("event_type"); v != "" {
		opts.EventType = v
	}
	if v := r.URL.Query().Get("limit"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil {
			opts.Limit = parsed
		}
	}
	if v := r.URL.Query().Get("start_time"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			opts.StartTime = &t
		}
	}
	if v := r.URL.Query().Get("end_time"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			opts.EndTime = &t
		}
	}

	events, total, err := h.evt.ListBySessionID(ctx, id, opts)
	if err != nil {
		glog.Errorf("ListEvents: session %s: %v", id, err)
		http.Error(w, "failed to list events", http.StatusInternalServerError)
		return
	}

	page := 1
	resp := struct {
		Kind  string         `json:"kind"`
		Page  int            `json:"page"`
		Size  int            `json:"size"`
		Total int64          `json:"total"`
		Items []SessionEvent `json:"items"`
	}{
		Kind:  "SessionEventList",
		Page:  page,
		Size:  len(events),
		Total: total,
		Items: events,
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if encErr := json.NewEncoder(w).Encode(resp); encErr != nil {
		glog.Errorf("ListEvents: encode response: %v", encErr)
	}
}
