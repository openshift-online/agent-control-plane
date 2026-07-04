package sessions

import (
	"context"
	"fmt"
	"sync"
)

type EventService interface {
	Push(ctx context.Context, evt *SessionEvent) (*SessionEvent, error)
	Subscribe(ctx context.Context, sessionID string) (<-chan *SessionEvent, func())
	ListBySessionID(ctx context.Context, sessionID string, opts EventListOptions) ([]SessionEvent, int64, error)
}

type sqlEventService struct {
	dao  EventDao
	mu   sync.RWMutex
	subs map[string][]chan *SessionEvent
}

func NewEventService(dao EventDao) EventService {
	return &sqlEventService{
		dao:  dao,
		subs: make(map[string][]chan *SessionEvent),
	}
}

func (s *sqlEventService) Push(ctx context.Context, evt *SessionEvent) (*SessionEvent, error) {
	if err := s.dao.Insert(ctx, evt); err != nil {
		return nil, fmt.Errorf("push session event: %w", err)
	}

	s.mu.RLock()
	chans := make([]chan *SessionEvent, len(s.subs[evt.SessionID]))
	copy(chans, s.subs[evt.SessionID])
	s.mu.RUnlock()

	for _, ch := range chans {
		select {
		case ch <- evt:
		default:
		}
	}
	return evt, nil
}

func (s *sqlEventService) Subscribe(ctx context.Context, sessionID string) (<-chan *SessionEvent, func()) {
	ch := make(chan *SessionEvent, 512)

	s.mu.Lock()
	s.subs[sessionID] = append(s.subs[sessionID], ch)
	s.mu.Unlock()

	var once sync.Once
	remove := func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			subs := s.subs[sessionID]
			for i, sub := range subs {
				if sub == ch {
					s.subs[sessionID] = append(subs[:i], subs[i+1:]...)
					close(ch)
					return
				}
			}
		})
	}

	go func() {
		<-ctx.Done()
		remove()
	}()

	return ch, remove
}

func (s *sqlEventService) ListBySessionID(ctx context.Context, sessionID string, opts EventListOptions) ([]SessionEvent, int64, error) {
	return s.dao.ListBySessionID(ctx, sessionID, opts)
}
