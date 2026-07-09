package clock

import "time"

type Clock interface {
	Now() time.Time
	NewTicker(d time.Duration) *Ticker
}

type Ticker struct {
	C    <-chan time.Time
	stop func()
}

func (t *Ticker) Stop() { t.stop() }

type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }

func (RealClock) NewTicker(d time.Duration) *Ticker {
	t := time.NewTicker(d)
	return &Ticker{
		C:    t.C,
		stop: t.Stop,
	}
}
