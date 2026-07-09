package scheduledSessions

import (
	"testing"
	"time"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/clock"
)

func TestValidateCron_Valid(t *testing.T) {
	for _, expr := range []string{"0 9 * * 1-5", "*/5 * * * *", "0 0 1 * *"} {
		if err := ValidateCron(expr); err != nil {
			t.Errorf("ValidateCron(%q) = %v, want nil", expr, err)
		}
	}
}

func TestValidateCron_Invalid(t *testing.T) {
	for _, expr := range []string{"not-a-cron", "0 25 * * *", "", "* * *"} {
		if err := ValidateCron(expr); err == nil {
			t.Errorf("ValidateCron(%q) = nil, want error", expr)
		}
	}
}

func TestNextRunAt_Enabled(t *testing.T) {
	// Monday 8am UTC
	clk := clock.NewFakeClock(time.Date(2026, 6, 22, 8, 0, 0, 0, time.UTC))
	next, err := NextRunAt(clk, "0 9 * * 1-5", "UTC", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if next == nil {
		t.Fatal("expected non-nil next_run_at")
	}
	want := time.Date(2026, 6, 22, 9, 0, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Fatalf("NextRunAt = %v, want %v", next, want)
	}
}

func TestNextRunAt_Disabled(t *testing.T) {
	clk := clock.NewFakeClock(time.Date(2026, 6, 22, 8, 0, 0, 0, time.UTC))
	next, err := NextRunAt(clk, "0 9 * * 1-5", "UTC", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if next != nil {
		t.Fatalf("expected nil for disabled schedule, got %v", next)
	}
}

func TestNextRunAt_InvalidTimezone(t *testing.T) {
	clk := clock.NewFakeClock(time.Date(2026, 6, 22, 8, 0, 0, 0, time.UTC))
	_, err := NextRunAt(clk, "0 9 * * *", "Mars/Olympus", true)
	if err == nil {
		t.Fatal("expected error for invalid timezone")
	}
}

func TestNextRunAtFrom_Advances(t *testing.T) {
	after := time.Date(2026, 6, 22, 9, 0, 0, 0, time.UTC)
	next, err := NextRunAtFrom(after, "0 9 * * 1-5", "UTC")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 9am on Monday June 22 → next is 9am Tuesday June 23
	want := time.Date(2026, 6, 23, 9, 0, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Fatalf("NextRunAtFrom = %v, want %v", next, want)
	}
}

func TestNextRunAt_DST_SpringForward(t *testing.T) {
	// US Eastern: spring forward on March 8, 2026 at 2:00 AM
	est, _ := time.LoadLocation("America/New_York")
	clk := clock.NewFakeClock(time.Date(2026, 3, 7, 23, 0, 0, 0, est))

	next, err := NextRunAt(clk, "0 2 * * *", "America/New_York", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if next == nil {
		t.Fatal("expected non-nil")
	}
	// 2:00 AM doesn't exist on March 8; should skip to March 9
	if next.Day() == 8 && next.Month() == 3 {
		// robfig/cron may resolve to 3am on the 8th — both are acceptable
		// as long as it doesn't produce 2am on the 8th (which doesn't exist)
		ny := next.In(est)
		if ny.Hour() == 2 && ny.Day() == 8 {
			t.Fatalf("should not schedule 2am on spring-forward day, got %v", ny)
		}
	}
}

func TestNextRunAt_DST_FallBack(t *testing.T) {
	// US Eastern: fall back on November 1, 2026 at 2:00 AM
	est, _ := time.LoadLocation("America/New_York")
	clk := clock.NewFakeClock(time.Date(2026, 10, 31, 23, 0, 0, 0, est))

	next, err := NextRunAt(clk, "0 1 * * *", "America/New_York", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if next == nil {
		t.Fatal("expected non-nil")
	}
	// Should fire at 1am on Nov 1 (first occurrence)
	ny := next.In(est)
	if ny.Hour() != 1 || ny.Day() != 1 || ny.Month() != 11 {
		t.Fatalf("expected 1am Nov 1, got %v", ny)
	}
}
