package client

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"time"

	"github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
)

type SessionEventListOptions struct {
	AfterSeq  int64
	EventType string
	Limit     int
	StartTime *time.Time
	EndTime   *time.Time
}

func (a *SessionAPI) ListEvents(ctx context.Context, sessionID string, opts *SessionEventListOptions) (*types.SessionEventList, error) {
	params := url.Values{}
	if opts != nil {
		if opts.AfterSeq > 0 {
			params.Set("after_seq", strconv.FormatInt(opts.AfterSeq, 10))
		}
		if opts.EventType != "" {
			params.Set("event_type", opts.EventType)
		}
		if opts.Limit > 0 {
			params.Set("limit", strconv.Itoa(opts.Limit))
		}
		if opts.StartTime != nil {
			params.Set("start_time", opts.StartTime.Format(time.RFC3339))
		}
		if opts.EndTime != nil {
			params.Set("end_time", opts.EndTime.Format(time.RFC3339))
		}
	}

	path := fmt.Sprintf("/sessions/%s/events/history", url.PathEscape(sessionID))
	if len(params) > 0 {
		path += "?" + params.Encode()
	}

	var result types.SessionEventList
	if err := a.client.do(ctx, "GET", path, nil, 200, &result); err != nil {
		return nil, err
	}
	return &result, nil
}
