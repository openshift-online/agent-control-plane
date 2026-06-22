# Session Activity Tracking Specification

## Purpose

Track the last time a session produced agent activity (message push, tool call, or any event written to the session message stream) so the dashboard can detect stale sessions without polling all messages. A session is considered stale when no activity has been recorded for more than 15 minutes.

## Requirements

### Requirement: Last Activity Timestamp Column

The `sessions` table SHALL have a nullable `last_activity_at` column of type `TIMESTAMPTZ`.

#### Scenario: New column added via migration
- GIVEN the database has existing sessions
- WHEN the migration runs
- THEN a `last_activity_at` column is added to the `sessions` table with a NULL default
- AND existing sessions retain NULL (no activity tracked before migration)

#### Scenario: Column is nullable
- GIVEN a session is created
- WHEN no messages have been pushed to it
- THEN `last_activity_at` SHALL be NULL

### Requirement: Activity Timestamp Updated on Message Push

The system SHALL update `last_activity_at` on the parent session each time a message is successfully inserted via `message_service.Push()`.

#### Scenario: Message pushed to session
- GIVEN an active session with id "S1"
- WHEN a message is pushed via `Push(ctx, "S1", "assistant", "hello")`
- THEN the session's `last_activity_at` SHALL be set to the current UTC time
- AND the message insert and activity update SHALL both succeed or both fail

#### Scenario: Multiple messages in sequence
- GIVEN a session with `last_activity_at` = T1
- WHEN a new message is pushed at time T2 (where T2 > T1)
- THEN `last_activity_at` SHALL be updated to T2

### Requirement: Exposed in API Response

The `last_activity_at` field SHALL be exposed as a read-only field in the Session API response, proto message, and OpenAPI schema.

#### Scenario: Session response includes last_activity_at
- GIVEN a session with `last_activity_at` = "2026-06-17T12:00:00Z"
- WHEN the session is fetched via `GET /sessions/{id}`
- THEN the response SHALL include `"last_activity_at": "2026-06-17T12:00:00Z"`

#### Scenario: Session with no activity
- GIVEN a session with `last_activity_at` = NULL
- WHEN the session is fetched via `GET /sessions/{id}`
- THEN the response SHALL omit `last_activity_at` or include it as null

### Requirement: Staleness Detection

The dashboard SHALL use `last_activity_at` to determine session staleness.

#### Scenario: Stale session detection
- GIVEN a session in "Running" phase with `last_activity_at` more than 15 minutes ago
- WHEN the dashboard evaluates the session list
- THEN the session SHALL be considered stale

#### Scenario: Active session detection
- GIVEN a session in "Running" phase with `last_activity_at` less than 15 minutes ago
- WHEN the dashboard evaluates the session list
- THEN the session SHALL be considered active

#### Scenario: Session with no activity record
- GIVEN a session in "Running" phase with `last_activity_at` = NULL
- WHEN the dashboard evaluates the session list
- THEN the session SHOULD be treated as unknown activity status (not assumed stale)

### Requirement: Migration Path

The migration SHALL be additive and backward-compatible.

#### Scenario: Rolling deployment
- GIVEN old API server instances that do not know about `last_activity_at`
- WHEN the migration has run
- THEN old instances SHALL continue to operate normally (column is nullable, no NOT NULL constraint)

#### Scenario: Existing sessions
- GIVEN sessions created before the migration
- WHEN the migration completes
- THEN those sessions SHALL have `last_activity_at` = NULL
