package scheduledSessions

import (
	"fmt"
	"time"

	"github.com/robfig/cron/v3"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/clock"
)

var cronParser = cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)

func ValidateCron(expr string) error {
	_, err := cronParser.Parse(expr)
	if err != nil {
		return fmt.Errorf("invalid cron expression %q: %w", expr, err)
	}
	return nil
}

func NextRunAt(clk clock.Clock, expr, tz string, enabled bool) (*time.Time, error) {
	if !enabled {
		return nil, nil
	}
	return NextRunAtFrom(clk.Now(), expr, tz)
}

func NextRunAtFrom(after time.Time, expr, tz string) (*time.Time, error) {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return nil, fmt.Errorf("invalid timezone %q: %w", tz, err)
	}
	sched, err := cronParser.Parse(expr)
	if err != nil {
		return nil, fmt.Errorf("invalid cron expression %q: %w", expr, err)
	}
	next := sched.Next(after.In(loc))
	return &next, nil
}
