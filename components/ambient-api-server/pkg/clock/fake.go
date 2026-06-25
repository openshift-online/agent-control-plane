package clock

import (
	"sync"
	"time"
)

type fakeTicker struct {
	ch       chan time.Time
	interval time.Duration
	nextFire time.Time
	stopped  bool
}

type FakeClock struct {
	mu      sync.Mutex
	now     time.Time
	tickers []*fakeTicker
}

func NewFakeClock(now time.Time) *FakeClock {
	return &FakeClock{now: now}
}

func (c *FakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *FakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	c.fireTickers()
}

func (c *FakeClock) SetTime(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = t
	c.fireTickers()
}

func (c *FakeClock) NewTicker(d time.Duration) *Ticker {
	c.mu.Lock()
	defer c.mu.Unlock()

	ft := &fakeTicker{
		ch:       make(chan time.Time, 1),
		interval: d,
		nextFire: c.now.Add(d),
	}
	c.tickers = append(c.tickers, ft)

	return &Ticker{
		C: ft.ch,
		stop: func() {
			c.mu.Lock()
			defer c.mu.Unlock()
			ft.stopped = true
		},
	}
}

func (c *FakeClock) fireTickers() {
	for _, ft := range c.tickers {
		if ft.stopped {
			continue
		}
		for !ft.nextFire.After(c.now) {
			select {
			case ft.ch <- c.now:
			default:
			}
			ft.nextFire = ft.nextFire.Add(ft.interval)
		}
	}
}
