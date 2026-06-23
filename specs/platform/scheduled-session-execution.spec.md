# Scheduled Session Execution

**Date:** 2026-06-23
**Status:** Active
**Issue:** [#60](https://github.com/openshift-online/agent-control-plane/issues/60)

---

## Purpose

The `ScheduledSession` kind defines a recurring cron schedule that ignites an Agent at specified times. Today the kind is CRUD-only — nothing evaluates cron expressions, computes `next_run_at`, or creates sessions at the scheduled time. This spec defines the execution semantics: how schedules are evaluated, how sessions are created, how failures and edge cases are handled, and how the creator's identity is preserved across triggered runs.

The scheduler runs inside the API server process. The control plane requires no changes — it picks up triggered sessions through the existing gRPC watch stream and reconciles them into Kubernetes Jobs exactly as it does today.

---

## Requirements

### Requirement: Cron Expression Evaluation

The API server SHALL compute `next_run_at` from the `schedule` and `timezone` fields whenever a `ScheduledSession` is created, updated, or triggered. The cron expression SHALL be parsed using the schedule's `timezone` field (IANA timezone string, default `UTC`). Cron expressions SHALL be validated at write time; invalid expressions SHALL be rejected with a `400 Bad Request`.

#### Scenario: Compute next_run_at on create
- GIVEN a user creates a ScheduledSession with `schedule = "0 9 * * 1-5"`, `timezone = "America/New_York"`, `enabled = true`
- WHEN the API server persists the record
- THEN `next_run_at` SHALL be set to the next weekday at 9:00 AM Eastern Time

#### Scenario: Recompute next_run_at on update
- GIVEN an enabled ScheduledSession with `next_run_at = 2026-06-24T09:00:00-04:00`
- WHEN the user patches `schedule` to `"0 14 * * *"`
- THEN `next_run_at` SHALL be recomputed to the next occurrence at 2:00 PM in the schedule's timezone

#### Scenario: Invalid cron expression rejected
- GIVEN a user creates a ScheduledSession with `schedule = "not-a-cron"`
- WHEN the API server validates the request
- THEN the request SHALL be rejected with `400 Bad Request` and an error message identifying the invalid expression

#### Scenario: Disabled schedule has no next_run_at
- GIVEN a ScheduledSession with `enabled = false`
- WHEN it is created or the `enabled` field is set to `false`
- THEN `next_run_at` SHALL be set to `NULL`

---

### Requirement: DST Handling

The scheduler SHALL handle Daylight Saving Time transitions correctly using the schedule's `timezone` field.

#### Scenario: Spring-forward (2:00 AM does not exist)
- GIVEN a ScheduledSession with `schedule = "0 2 * * *"` and `timezone = "America/New_York"`
- WHEN the DST spring-forward transition skips 2:00 AM
- THEN the scheduler SHALL skip that occurrence and advance `next_run_at` to the next valid 2:00 AM

#### Scenario: Fall-back (1:00 AM occurs twice)
- GIVEN a ScheduledSession with `schedule = "0 1 * * *"` and `timezone = "America/New_York"`
- WHEN the DST fall-back transition causes 1:00 AM to occur twice
- THEN the scheduler SHALL fire exactly once during the first occurrence

---

### Requirement: Scheduler Polling Controller

The API server SHALL run a background polling controller that evaluates due schedules and creates sessions. The controller SHALL be registered as a background controller within the API server process.

#### Scenario: Poll and fire due schedule
- GIVEN an enabled ScheduledSession with `next_run_at <= now()`
- WHEN the scheduler polling loop executes
- THEN the scheduler SHALL create a new Session from the schedule's template fields
- AND update `last_run_at` to the current time
- AND compute and persist the next `next_run_at`

#### Scenario: Polling interval
- GIVEN the scheduler controller is running
- WHEN no schedules are due
- THEN the controller SHALL poll every 30 seconds

#### Scenario: Multi-replica safety
- GIVEN the API server is running with multiple replicas
- WHEN the polling loop executes
- THEN the controller SHALL acquire a PostgreSQL advisory lock (using the existing `AdvisoryLockFactory` with a fixed lock type `"scheduled-session-scheduler"`) to ensure only one replica runs the polling loop at a time
- AND if the lock is not acquired, the tick SHALL be skipped silently

#### Scenario: Graceful shutdown
- GIVEN the scheduler polling loop is running
- WHEN the API server receives SIGTERM or SIGINT
- THEN the scheduler SHALL stop its polling ticker
- AND any in-progress schedule evaluation SHALL complete before the controller exits
- AND no new polling ticks SHALL start after shutdown is signaled

#### Scenario: More due schedules than batch limit
- GIVEN 200 enabled schedules are due (next_run_at <= now())
- WHEN the scheduler polls
- THEN the polling query SHALL include `LIMIT 100` (configurable)
- AND remaining due schedules SHALL be picked up on the next polling tick (30 seconds later)

---

### Requirement: Creator Identity Propagation

The `ScheduledSession` model SHALL include a `created_by_user_id` field that records who created the schedule. Sessions created by the scheduler SHALL inherit this identity. The field SHALL be extracted from the authenticated JWT username via `auth.GetUsernameFromContext(ctx)` — the same pattern used by the session handler (`sessions/handler.go:88-89`).

#### Scenario: Creator identity set on create
- GIVEN a user with ID `user-abc` creates a ScheduledSession
- WHEN the API server persists the record
- THEN `created_by_user_id` SHALL be set to `user-abc` from `auth.GetUsernameFromContext(ctx)`
- AND `created_by_user_id` SHALL be immutable (ignored on PATCH)

#### Scenario: Triggered session inherits creator identity
- GIVEN a ScheduledSession with `created_by_user_id = "user-abc"`
- WHEN the scheduler fires and creates a Session
- THEN the new Session's `created_by_user_id` SHALL be set to `user-abc`
- AND the scheduler SHALL call the session service layer's `Create` method directly (same code path as `ignite_handler.go:72`), setting `CreatedByUserId` on the session model before creation

---

### Requirement: Pre-Trigger Authorization Check

Before creating a session from a schedule, the scheduler SHALL verify that the schedule's creator still has permission to create sessions in the schedule's project. The scheduler runs as internal API server code (not as a user request), so it SHALL call the RBAC evaluator directly: `evaluator.Evaluate(ctx, createdByUserId, "session", "create", projectScope)`.

#### Scenario: Creator still authorized
- GIVEN a ScheduledSession with `created_by_user_id = "user-abc"` in project `my-project`
- AND user `user-abc` has `session:create` permission on `my-project` (via `project:editor` or higher role)
- WHEN the scheduler fires
- THEN a Session SHALL be created normally

#### Scenario: Creator no longer authorized
- GIVEN a ScheduledSession with `created_by_user_id = "user-abc"` in project `my-project`
- AND user `user-abc` no longer has `session:create` permission on `my-project`
- WHEN the scheduler fires
- THEN no Session SHALL be created
- AND the schedule SHALL be set to `enabled = false`
- AND a status message SHALL be recorded indicating the creator no longer has permission

#### Scenario: Creator identity is NULL (pre-migration schedule)
- GIVEN an existing ScheduledSession where `created_by_user_id` is NULL (created before the migration)
- WHEN the scheduler evaluates this schedule
- THEN the scheduler SHALL skip the schedule
- AND set `enabled = false`
- AND record a status message: "Schedule disabled: no creator identity. Re-create to enable."

---

### Requirement: At-Least-Once Delivery with Idempotency

The scheduler SHALL provide at-least-once delivery. Duplicate session creation SHALL be prevented by a database-level idempotency key.

#### Scenario: Idempotent session creation
- GIVEN a ScheduledSession with ID `sched-1` due at `2026-06-24T09:00:00Z`
- WHEN the scheduler fires and creates a Session with `source_scheduled_session_id = "sched-1"` and `scheduled_for = "2026-06-24T09:00:00Z"`
- AND the scheduler attempts to fire again for the same schedule and time (e.g., after a crash recovery)
- THEN the second creation attempt SHALL be rejected by the `UNIQUE(source_scheduled_session_id, scheduled_for)` constraint
- AND no duplicate Session SHALL exist

#### Scenario: Retry after transient failure
- GIVEN the scheduler fires for a due schedule but the session creation fails due to a transient error
- WHEN the next polling tick executes
- THEN the scheduler SHALL retry the creation because `next_run_at` was not advanced
- AND the idempotency constraint SHALL prevent duplicates if the first attempt partially succeeded

---

### Requirement: Catch-Up After Downtime

When the scheduler starts or recovers from downtime, it SHALL fire at most one catch-up session per schedule, then advance to the next future occurrence.

#### Scenario: Single catch-up after short downtime
- GIVEN a ScheduledSession with `schedule = "0 * * * *"` (hourly) and `next_run_at = 2026-06-24T08:00:00Z`
- AND the API server was down from 07:50 to 08:15
- WHEN the scheduler resumes at 08:15
- THEN exactly one Session SHALL be created for this schedule
- AND `next_run_at` SHALL be advanced to `2026-06-24T09:00:00Z` (next future occurrence computed from `now()`)

#### Scenario: No thundering herd after extended downtime
- GIVEN a ScheduledSession with `schedule = "0 * * * *"` (hourly) and `next_run_at = 2026-06-24T02:00:00Z`
- AND the API server was down for 6 hours
- WHEN the scheduler resumes at 08:15
- THEN exactly one Session SHALL be created (not six)
- AND `next_run_at` SHALL be computed from `now()`, not from the missed time

---

### Requirement: Overlap Policy

The scheduler SHALL check for active sessions from the same schedule before creating a new one. The default overlap policy SHALL be `skip`.

#### Scenario: Skip when previous run still active (default)
- GIVEN a ScheduledSession with `overlap_policy = "skip"` (or not set, defaulting to `skip`)
- AND a Session with `source_scheduled_session_id` matching this schedule exists with `phase` NOT IN (`Completed`, `Failed`, `Stopped`)
- WHEN the scheduler fires for this schedule
- THEN no new Session SHALL be created
- AND `next_run_at` SHALL be advanced to the next occurrence
- AND the skip SHALL be logged

#### Scenario: Allow concurrent runs when configured
- GIVEN a ScheduledSession with `overlap_policy = "allow"`
- AND a Session from this schedule is still active
- WHEN the scheduler fires
- THEN a new Session SHALL be created regardless of the active session

---

### Requirement: Manual Trigger

The `POST .../trigger` endpoint SHALL create a session immediately, outside the cron schedule. The response SHALL return the created Session object (same shape as the session creation response).

#### Scenario: Manual trigger creates session
- GIVEN an enabled ScheduledSession
- WHEN a user calls `POST .../trigger`
- THEN a new Session SHALL be created using the schedule's template fields
- AND `scheduled_for` SHALL be set to the current time (truncated to second precision)
- AND `last_run_at` SHALL NOT be updated
- AND `next_run_at` SHALL NOT be changed
- AND the response SHALL be the created Session with HTTP 201

#### Scenario: Manual trigger bypasses overlap check
- GIVEN a ScheduledSession with `overlap_policy = "skip"` and an active session from this schedule
- WHEN a user calls `POST .../trigger`
- THEN a new Session SHALL be created regardless of the active session

#### Scenario: Manual trigger idempotency
- GIVEN a manual trigger at time T
- AND a scheduled trigger also fires at time T (same second)
- WHEN both attempt to create sessions
- THEN the `UNIQUE(source_scheduled_session_id, scheduled_for)` constraint SHALL prevent duplicate creation

---

### Requirement: Triggered Session Template

When the scheduler or manual trigger creates a session, it SHALL copy template fields from the `ScheduledSession` to the new `Session`.

#### Scenario: Template fields copied to session
- GIVEN a ScheduledSession with `session_prompt = "Run nightly CI"`, `timeout = 3600`, `agent_id = "agent-1"`, `runner_type = "claude-code"`
- WHEN the scheduler fires
- THEN the created Session SHALL have:
  - `prompt` = `"Run nightly CI"`
  - `timeout` = `3600`
  - `agent_id` = `"agent-1"`
  - `source_scheduled_session_id` = the ScheduledSession's ID
  - `scheduled_for` = the cron tick time
  - `created_by_user_id` = the ScheduledSession's `created_by_user_id`

---

### Requirement: Runs Endpoint

`GET .../runs` SHALL return sessions created by this schedule, ordered by creation time descending.

#### Scenario: List runs for a schedule
- GIVEN a ScheduledSession that has triggered 3 sessions
- WHEN a user calls `GET .../runs`
- THEN the response SHALL contain the 3 sessions ordered by `created_at` descending
- AND each session SHALL have `source_scheduled_session_id` set to this schedule's ID

#### Scenario: No runs yet
- GIVEN a ScheduledSession that has never fired
- WHEN a user calls `GET .../runs`
- THEN the response SHALL be an empty list (not a hardcoded stub)

---

### Requirement: Session Completion Lifecycle

Triggered sessions SHALL follow the existing session lifecycle for completion and cleanup. No new completion mechanism is required.

#### Scenario: Session completes after agent run finishes
- GIVEN a Session created by the scheduler with `stop_on_run_finished = true` (inherited from the ScheduledSession template)
- WHEN the runner emits a `RUN_FINISHED` AG-UI event and the Claude Code process exits
- THEN the runner pod SHALL terminate with status `Succeeded`
- AND the control plane's `PodStatusSyncer` SHALL detect the pod termination and update the session phase to `Completed`
- AND the control plane SHALL deprovision the pod, secret, service account, and service

#### Scenario: Default stop_on_run_finished for scheduled sessions
- GIVEN a ScheduledSession with `stop_on_run_finished` not explicitly set
- WHEN the scheduler creates a Session from this schedule
- THEN `stop_on_run_finished` SHOULD default to `true` for triggered sessions, since scheduled sessions are fire-and-forget by nature

#### Scenario: Session fails during execution
- GIVEN a Session created by the scheduler
- WHEN the runner pod fails (crash, OOM, timeout)
- THEN the control plane SHALL set the session phase to `Failed`
- AND cleanup SHALL proceed normally via the existing `deprovisionSession` path

---

### Requirement: No Token Storage

The scheduler SHALL NOT store user OAuth tokens, refresh tokens, or any credentials. Only the `created_by_user_id` (a user identifier) SHALL be stored on the `ScheduledSession`.

#### Scenario: Credential resolution at trigger time
- GIVEN a ScheduledSession with `created_by_user_id = "user-abc"`
- WHEN the scheduler fires
- THEN credentials for the session SHALL be resolved at trigger time through the existing RBAC and credential-binding infrastructure
- AND no stored tokens from the ScheduledSession record SHALL be used

---

### Requirement: Deleted Agent Handling

The scheduler SHALL handle the case where a ScheduledSession's `agent_id` references a soft-deleted agent.

#### Scenario: Agent deleted before trigger
- GIVEN a ScheduledSession with `agent_id = "agent-1"`
- AND agent `agent-1` has been soft-deleted
- WHEN the scheduler fires for this schedule
- THEN no Session SHALL be created
- AND the schedule SHALL be set to `enabled = false`
- AND a status message SHALL be recorded: "Schedule disabled: referenced agent no longer exists."

#### Scenario: Agent ID is NULL
- GIVEN a ScheduledSession with `agent_id = NULL`
- WHEN the scheduler fires
- THEN a project-scoped Session SHALL be created (with `project_id` set but no `agent_id`)

---

### Requirement: Deleted Schedule with Running Sessions

When a ScheduledSession is soft-deleted, sessions previously created by it SHALL continue running to completion. The FK link is preserved for audit purposes.

#### Scenario: Schedule deleted while sessions are running
- GIVEN a ScheduledSession that has created 2 sessions, one of which is still running
- WHEN the ScheduledSession is soft-deleted
- THEN the running session SHALL continue to completion unaffected
- AND the session's `source_scheduled_session_id` SHALL remain set (not nullified)
- AND the scheduler SHALL stop evaluating the deleted schedule (filtered by `deleted_at IS NULL`)

---

### Requirement: No Control Plane Database Access

The scheduler SHALL run inside the API server process. The control plane SHALL NOT require direct PostgreSQL access for scheduling. The control plane SHALL continue to discover triggered sessions through the existing gRPC session watch stream.

#### Scenario: Control plane unaware of scheduling
- GIVEN the scheduler creates a session from a due schedule
- WHEN the session is persisted in the database
- THEN the existing gRPC `WatchSessions` stream SHALL deliver the event to the control plane
- AND the control plane SHALL reconcile it into a Kubernetes Job/Pod using the existing `KubeReconciler`
- AND no changes to the control plane codebase SHALL be required for core scheduling

---

## Data Model Changes

### ScheduledSession — New Fields

| Field | Type | Nullable | Default | Notes |
|-------|------|----------|---------|-------|
| `created_by_user_id` | `string` | yes | `NULL` | Logical reference to users table (no FK constraint — matches Session.created_by_user_id pattern). Set from JWT on create. Immutable (ignored on PATCH). |
| `overlap_policy` | `string` | no | `"skip"` | `"skip"` or `"allow"`. Validated at application level. |

### Session — New Fields

| Field | Type | Nullable | Default | Notes |
|-------|------|----------|---------|-------|
| `source_scheduled_session_id` | `string` | yes | `NULL` | Logical reference to scheduled_sessions table (no FK constraint — soft-deleted schedules should not cascade to sessions). Set only for scheduler/trigger-created sessions. |
| `scheduled_for` | `timestamp` | yes | `NULL` | The cron tick time this session was created for. Both fields are either both NULL or both non-NULL. |

### New Indexes and Constraints

| Index / Constraint | Definition | Purpose |
|--------------------|------------|---------|
| Partial unique index | `CREATE UNIQUE INDEX idx_sessions_schedule_idempotency ON sessions(source_scheduled_session_id, scheduled_for) WHERE source_scheduled_session_id IS NOT NULL` | Idempotency — prevents duplicate session creation. Partial index avoids NULL-pair uniqueness issues for non-scheduled sessions. |
| Partial index | `CREATE INDEX idx_ss_due ON scheduled_sessions(next_run_at) WHERE enabled = true AND deleted_at IS NULL` | Efficient polling query for due schedules |

### Migration Steps (ordered)

1. Add `created_by_user_id` column to `scheduled_sessions` (nullable, no default)
2. Add `overlap_policy` column to `scheduled_sessions` with default `"skip"`
3. Add `source_scheduled_session_id` column to `sessions` (nullable)
4. Add `scheduled_for` column to `sessions` (nullable)
5. Create partial unique index `idx_sessions_schedule_idempotency`
6. Create partial index `idx_ss_due`
7. Backfill `next_run_at` for existing enabled scheduled sessions:
   - Parse each schedule's cron expression using its `timezone` field
   - On parse failure, set `enabled = false` and `next_run_at = NULL`, log a warning
   - On success, compute `next_run_at` from `now()`
8. Existing scheduled sessions with NULL `created_by_user_id` are left as-is — the scheduler skips and disables them on first evaluation (see Pre-Trigger Authorization Check)

### Cross-Spec Updates Required

The following specs SHALL be updated to reflect these changes:
- **`specs/platform/data-model.spec.md`**: Add `created_by_user_id`, `overlap_policy` to the ScheduledSession ERD and field table. Add `source_scheduled_session_id`, `scheduled_for` to the Session ERD and field table. Update trigger semantics (line 534) to reference `overlap_policy` instead of unconditional skip.
- **OpenAPI spec** (`openapi/openapi.yaml`): Add new fields to `ScheduledSession` and `Session` schemas. Update trigger response to return the created Session.
- **SDKs** (Go, Python, TypeScript): Regenerate from updated OpenAPI spec. The `Trigger()` method return type changes from `error` to `(Session, error)`. The `Runs()` method return type changes from untyped map to `SessionList`.

### Polling Query

The scheduler's polling query SHALL be:

```sql
SELECT * FROM scheduled_sessions
WHERE enabled = true
  AND next_run_at <= now()
  AND deleted_at IS NULL
ORDER BY next_run_at
LIMIT 100
```

The advisory lock ensures only one replica executes this query at a time. The `LIMIT` ensures each tick processes a bounded batch; remaining due schedules are picked up on subsequent ticks.

---

## Design Decisions

| Decision | Rationale |
|---|---|
| Scheduler in API server, not control plane | The API server already owns PostgreSQL, GORM, advisory locks, and the `scheduled_sessions` table. The CP has zero database access by design and communicates only via gRPC. Keeping the scheduler where the data lives eliminates architectural boundary violations, new database connections, and cross-process coordination. |
| Trigger creates sessions via internal service, not agent start endpoint | The scheduler calls `SessionService.Create` directly — the same code path as `ignite_handler.go:72`. The agent start endpoint has no active-session guard in practice (multiple sessions per agent are already possible), so no bypass is needed. Direct service calls also avoid HTTP overhead and the need to construct a fake request context. |
| Pure polling, no in-memory timers | In-memory timers (`time.AfterFunc`) are lost on crash, require leader election for coordination, and need a polling fallback for recovery anyway. A 30-second polling loop against an indexed table is simpler, self-healing, and produces identical reliability characteristics. |
| No River job queue | River OSS periodic jobs are in-memory on the elected leader — the same durability as raw timers. River Pro (durable periodic jobs) is paid. River adds `pgx/v5` alongside GORM (two connection pools), 6 new tables, and a competing leader election mechanism. The existing session pipeline already serves as a job queue. |
| No K8s CronJobs | CronJobs create a second source of truth in etcd, require trigger-pod indirection, break user-token-auth (run as ServiceAccount, not the schedule creator), and scatter scheduling state across namespaces. |
| At-least-once with idempotency over at-most-once | Missing a scheduled session is worse than a harmless duplicate attempt rejected by a database constraint. The `UNIQUE(source_scheduled_session_id, scheduled_for)` constraint makes at-least-once operationally equivalent to exactly-once. |
| Catch-up fires once, not all missed | AI sessions act on current repository state. Replaying N missed intervals after downtime wastes compute with no benefit. One catch-up run per schedule is sufficient. |
| Skip-on-overlap as default | Concurrent AI sessions from the same schedule risk resource exhaustion and conflicting side effects. Skipping is the safe default; `allow` is opt-in per schedule. |
| `created_by_user_id` over token storage | Storing user tokens creates a high-value attack target and requires rotation infrastructure. Storing only the user ID and resolving credentials at trigger time through existing RBAC is simpler and more secure. |
| Pre-trigger auth check | Schedule creation time is not trigger time. A deprovisioned user should not continue spawning sessions indefinitely. The scheduler verifies the creator's permissions before every trigger. |
| No gRPC watch for scheduled_sessions as prerequisite | The scheduler lives in the same process as the database. Watch streams for `scheduled_sessions` provide UI reactivity (live `next_run_at` updates) but are not required for scheduling and can be added later. |
| Logical references, not FK constraints | `created_by_user_id` and `source_scheduled_session_id` are logical references (matching the existing `Session.created_by_user_id` pattern) rather than DB-level foreign keys. This avoids cascade complications with soft-deleted records and keeps the migration simple. |
| Advisory lock over `FOR UPDATE SKIP LOCKED` | A single advisory lock per polling tick is simpler than per-row locking. At <1000 schedules the entire polling loop completes in milliseconds, so per-row contention is not a concern. If the API server scales to many replicas, the advisory lock ensures exactly one runs the scheduler. |
| Partial unique index for idempotency | The unique index on `(source_scheduled_session_id, scheduled_for)` is partial (`WHERE source_scheduled_session_id IS NOT NULL`) to avoid PostgreSQL's NULL-pair uniqueness behavior. Non-scheduled sessions (NULL, NULL) are excluded from the constraint. |
