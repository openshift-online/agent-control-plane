package clock

import (
	"testing"
	"time"
)

func TestRealClock_Now(t *testing.T) {
	c := RealClock{}
	before := time.Now()
	got := c.Now()
	after := time.Now()
	if got.Before(before) || got.After(after) {
		t.Fatalf("RealClock.Now() = %v, want between %v and %v", got, before, after)
	}
}

func TestFakeClock_NowAndAdvance(t *testing.T) {
	start := time.Date(2026, 6, 24, 9, 0, 0, 0, time.UTC)
	c := NewFakeClock(start)

	if got := c.Now(); !got.Equal(start) {
		t.Fatalf("Now() = %v, want %v", got, start)
	}

	c.Advance(5 * time.Minute)
	want := start.Add(5 * time.Minute)
	if got := c.Now(); !got.Equal(want) {
		t.Fatalf("after Advance(5m), Now() = %v, want %v", got, want)
	}
}

func TestFakeClock_SetTime(t *testing.T) {
	start := time.Date(2026, 6, 24, 9, 0, 0, 0, time.UTC)
	c := NewFakeClock(start)

	target := time.Date(2026, 12, 25, 0, 0, 0, 0, time.UTC)
	c.SetTime(target)
	if got := c.Now(); !got.Equal(target) {
		t.Fatalf("SetTime() then Now() = %v, want %v", got, target)
	}
}

func TestFakeClock_TickerFires(t *testing.T) {
	start := time.Date(2026, 6, 24, 9, 0, 0, 0, time.UTC)
	c := NewFakeClock(start)

	ticker := c.NewTicker(30 * time.Second)
	defer ticker.Stop()

	c.Advance(31 * time.Second)

	select {
	case <-ticker.C:
	default:
		t.Fatal("expected ticker to fire after advancing past interval")
	}
}

func TestFakeClock_TickerDoesNotFireEarly(t *testing.T) {
	start := time.Date(2026, 6, 24, 9, 0, 0, 0, time.UTC)
	c := NewFakeClock(start)

	ticker := c.NewTicker(30 * time.Second)
	defer ticker.Stop()

	c.Advance(29 * time.Second)

	select {
	case <-ticker.C:
		t.Fatal("ticker should not fire before interval elapses")
	default:
	}
}

func TestFakeClock_TickerStop(t *testing.T) {
	start := time.Date(2026, 6, 24, 9, 0, 0, 0, time.UTC)
	c := NewFakeClock(start)

	ticker := c.NewTicker(30 * time.Second)
	ticker.Stop()

	c.Advance(60 * time.Second)

	select {
	case <-ticker.C:
		t.Fatal("stopped ticker should not fire")
	default:
	}
}

func TestFakeClock_TickerMultipleFires(t *testing.T) {
	start := time.Date(2026, 6, 24, 9, 0, 0, 0, time.UTC)
	c := NewFakeClock(start)

	ticker := c.NewTicker(10 * time.Second)
	defer ticker.Stop()

	c.Advance(25 * time.Second)

	// Should have fired at least once (channel is buffered cap 1)
	select {
	case <-ticker.C:
	default:
		t.Fatal("expected ticker to fire")
	}
}

func TestFakeClock_SetTimeFiresTickers(t *testing.T) {
	start := time.Date(2026, 6, 24, 9, 0, 0, 0, time.UTC)
	c := NewFakeClock(start)

	ticker := c.NewTicker(30 * time.Second)
	defer ticker.Stop()

	c.SetTime(start.Add(31 * time.Second))

	select {
	case <-ticker.C:
	default:
		t.Fatal("SetTime should fire tickers")
	}
}
