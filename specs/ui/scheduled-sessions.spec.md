# Scheduled Sessions UI

**Date:** 2026-06-23
**Status:** Active

---

## Purpose

Provide a web interface for managing scheduled sessions — recurring cron-based triggers that create sessions from templates. The UI lives under the **Operate** navigation group alongside Dashboard and Sessions. It provides full CRUD, lifecycle actions (suspend/resume/trigger), and a runs history view.

---

## Requirements

### Requirement: Navigation Entry

The Scheduled Sessions page SHALL appear in the **Operate** nav group in the sidebar, after Sessions.

#### Scenario: Nav item visible
- GIVEN a user navigates to a project
- WHEN the sidebar renders
- THEN "Schedules" SHALL appear under the Operate group with a `CalendarClock` icon
- AND clicking it SHALL navigate to `/{projectId}/schedules`

---

### Requirement: List View

The schedules list page SHALL display all scheduled sessions for the current project in a sortable, filterable table.

#### Scenario: Table columns
- GIVEN the user is on the schedules list page
- THEN the table SHALL display columns: Name, Schedule (cron expression), Timezone, Status (enabled/disabled badge), Next Run, Last Run, Overlap Policy
- AND rows SHALL be clickable (future: detail view)

#### Scenario: Empty state
- GIVEN a project with no scheduled sessions
- WHEN the user visits the schedules page
- THEN an empty state SHALL display with a `CalendarClock` icon, "No schedules" title, and a "New Schedule" button

#### Scenario: Search filter
- GIVEN schedules exist
- WHEN the user types in the search input
- THEN the table SHALL filter by name (client-side)

---

### Requirement: Create Schedule

The user SHALL be able to create a new scheduled session via a slide-out sheet.

#### Scenario: Create form fields
- GIVEN the user clicks "New Schedule"
- WHEN the create sheet opens
- THEN the form SHALL include:
  - Name (required, text input)
  - Agent (required, dropdown of project agents)
  - Schedule (required, text input with cron expression placeholder)
  - Timezone (optional, dropdown defaulting to UTC)
  - Prompt (optional, textarea)
  - Enabled (optional, switch defaulting to true)
  - Advanced settings (collapsible): overlap policy (skip/allow), timeout, inactivity timeout, stop on run finished

#### Scenario: Successful create
- GIVEN valid form data
- WHEN the user submits
- THEN the schedule SHALL be created via `POST /projects/{id}/scheduled-sessions`
- AND the sheet SHALL close
- AND the list SHALL refresh

#### Scenario: Validation error
- GIVEN an invalid cron expression
- WHEN the user submits
- THEN the API error SHALL be displayed in the form

---

### Requirement: Edit Schedule

The user SHALL be able to edit an existing scheduled session.

#### Scenario: Edit form
- GIVEN the user clicks the edit action on a schedule row
- WHEN the edit sheet opens
- THEN it SHALL be pre-populated with the schedule's current values
- AND the user SHALL be able to modify any mutable field

---

### Requirement: Delete Schedule

The user SHALL be able to delete a scheduled session with confirmation.

#### Scenario: Delete confirmation
- GIVEN the user clicks delete on a schedule row
- WHEN the confirmation dialog appears
- THEN it SHALL warn that deletion is permanent
- AND on confirm, the schedule SHALL be deleted via `DELETE /projects/{id}/scheduled-sessions/{id}`

---

### Requirement: Suspend and Resume

The user SHALL be able to toggle a schedule's enabled state.

#### Scenario: Suspend
- GIVEN an enabled schedule
- WHEN the user clicks "Suspend" in the row actions
- THEN the schedule SHALL be suspended via `POST .../suspend`
- AND the status badge SHALL update to "Disabled"

#### Scenario: Resume
- GIVEN a disabled schedule
- WHEN the user clicks "Resume" in the row actions
- THEN the schedule SHALL be resumed via `POST .../resume`
- AND the status badge SHALL update to "Enabled"

---

### Requirement: Manual Trigger

The user SHALL be able to manually trigger a schedule to create a session immediately.

#### Scenario: Trigger
- GIVEN any schedule
- WHEN the user clicks "Trigger Now" in the row actions
- THEN a session SHALL be created via `POST .../trigger`
- AND a success toast SHALL display with the created session name

---

### Requirement: Runs History

The user SHALL be able to view sessions created by a schedule.

#### Scenario: Runs view
- GIVEN a schedule that has triggered sessions
- WHEN the user clicks "View Runs" in the row actions
- THEN a dialog or sheet SHALL display the sessions list from `GET .../runs`
- AND each session SHALL show name, phase, created time

---

## Architecture

### Files to create/modify

| Path | Purpose |
|------|---------|
| `src/domain/types.ts` | Add `DomainScheduledSession` and related types |
| `src/ports/scheduled-sessions.ts` | Port interface |
| `src/adapters/sdk-scheduled-sessions.ts` | SDK adapter implementation |
| `src/adapters/sdk-client.ts` | Add `getScheduledSessionAPI()` |
| `src/adapters/mappers.ts` | Add `mapSdkScheduledSessionToDomain` |
| `src/queries/use-scheduled-sessions.ts` | React Query hooks |
| `src/queries/query-keys.ts` | Add scheduled session query keys |
| `src/components/app-sidebar.tsx` | Add "Schedules" nav item to Operate group |
| `src/app/(dashboard)/[projectId]/schedules/page.tsx` | List page |
| `src/app/(dashboard)/[projectId]/schedules/_components/` | Table, columns, create/edit sheet, runs dialog |

### Patterns to follow

- Hexagonal: port interface → SDK adapter → React Query hook → component
- Table: `@tanstack/react-table` with `createColumnHelper`
- Forms: Sheet (slide-out) with `useState` fields, validation on submit
- Actions: `DropdownMenu` in row actions column
- Data fetching: `useQuery` with query keys, `useMutation` with cache invalidation
