# Project Sharing Specification

## Purpose

Project sharing allows users to grant other platform users access to their projects
with role-based permissions. The UI follows a Google Drive-style sharing dialog:
an autocomplete input finds platform users, a role picker assigns permissions, and a
collaborator list shows current access with inline role changes and removal. Projects
visually indicate shared status and the current user's role throughout the UI.

> **Terminology note:** "Collaborator" is a UI display term for any user with a
> project-scoped role binding. It is not a backend entity. "Project ownership transfer"
> refers specifically to `project:owner` scope — not `credential:owner`.

## Feature Flag

All sharing UI surfaces SHALL be gated behind the feature flag
`feature.project-sharing.enabled`, defined in
`components/manifests/base/core/flags.json`.

Gated surfaces:
- Share button (project dashboard and project picker cards)
- Settings gear icon in nav header
- Settings page (`/{projectId}/settings`)
- Role pill and shared indicator on project cards
- Avatar stack on project cards

The flag SHALL use `useWorkspaceFlag(projectName, 'feature.project-sharing.enabled')`
in project-scoped contexts.

## Requirements

### Requirement: Share Dialog

The system SHALL present a sharing dialog accessible from:

1. A **Share** button on the project dashboard page (`/{projectId}`)
2. A **Share** button (or icon) on each project card in the project picker page (`/`)
3. The **Members** tab on the project settings page (`/{projectId}/settings`)

A single shared `CollaboratorManager` component SHALL be extracted and used in both
the dialog wrapper and the Members tab inline. The Share dialog is a convenience
shortcut; the Members tab is the canonical location for access management.

The dialog SHALL contain:

- A **user search input** built with the shadcn Combobox pattern (Command + Popover),
  querying the platform's users table
- A **role selector** defaulting to `project:viewer`, with options determined by the
  caller's role level per the strictly-below rule:

| Caller role | Available options |
|-------------|------------------|
| `platform:admin` | Owner, Editor, Viewer |
| `project:owner` | Editor, Viewer |
| `project:editor` | Viewer |
| `project:viewer` | None (read-only mode) |

- An **Add** button that creates the role binding silently (no invitation flow)
- A **collaborator list** showing all users with project-scoped role bindings,
  displaying: avatar/initials, display name, username, and current role
- Inline **role change** via `PATCH /role_bindings/{id}` with the new `role_id`
  (not delete-then-create)
- A **remove** action on each collaborator row (with confirmation)
- A user SHALL have at most one project-scoped role binding per project. Adding a user
  who already has a binding SHALL show an error indicating they already have access

**States:**

- **Loading:** Skeleton rows in the collaborator list; spinner in the search input
  during autocomplete queries
- **Error:** Error banner above the collaborator list on fetch failure; toast on
  mutation failure
- **Empty:** "No collaborators yet — share this project to get started" when the
  project has only the owner

#### Scenario: Owner shares project with a colleague

- GIVEN user A has `project:owner` on proj-1
- WHEN user A opens the Share dialog, types "jane" in the search input
- THEN the autocomplete shows matching platform users
- WHEN user A selects "Jane Doe" and chooses "Editor"
- AND clicks "Add"
- THEN a RoleBinding is created with role_id=(ID of `project:editor`), scope=project,
  project_id=proj-1, user_id=(Jane's user ID)
- AND Jane appears in the collaborator list with role "Editor"

#### Scenario: Owner removes a collaborator

- GIVEN user A has `project:owner` on proj-1
- AND user B has `project:viewer` on proj-1
- WHEN user A clicks the remove action on user B's row
- THEN a confirmation prompt appears
- WHEN user A confirms
- THEN the RoleBinding is deleted
- AND user B disappears from the collaborator list

#### Scenario: Owner changes a collaborator's role

- GIVEN user A has `project:owner` on proj-1
- AND user B has `project:viewer` on proj-1 (binding ID = rb-1)
- WHEN user A changes user B's role dropdown to "Editor"
- THEN `PATCH /role_bindings/rb-1` is called with `{"role_id": "<project:editor ID>"}`
- AND the collaborator list reflects the updated role

#### Scenario: Non-owner cannot escalate beyond their own role

- GIVEN user A has `project:editor` on proj-1
- WHEN user A opens the Share dialog
- THEN the role selector only shows `project:viewer` (strictly below their own level)
- AND `project:editor` and `project:owner` are not available

#### Scenario: Viewer can see but not modify sharing

- GIVEN user A has `project:viewer` on proj-1
- WHEN user A opens the Share dialog
- THEN the collaborator list is shown in read-only mode
- AND no add/remove/change controls are visible

#### Scenario: Platform admin shares on a project they do not own

- GIVEN user A has `platform:admin` (global scope, no project-scoped binding on proj-1)
- WHEN user A opens the Share dialog on proj-1
- THEN the role selector shows Owner, Editor, and Viewer
- AND user A can add, remove, and change roles for any collaborator
- AND user A can grant `project:owner` to another user

#### Scenario: Collaborator removes themselves from a project

- GIVEN user A has `project:editor` on proj-1
- WHEN user A clicks "Leave project" on their own row in the collaborator list
- THEN a confirmation prompt appears: "You will lose access to this project"
- WHEN user A confirms
- THEN user A's RoleBinding is deleted
- AND user A is redirected to the project picker page (`/`)

#### Scenario: Sole owner cannot remove themselves

- GIVEN user A is the only `project:owner` on proj-1
- WHEN user A views the collaborator list
- THEN no remove/leave action is available on their own row
- AND a tooltip explains: "Transfer project ownership before leaving"

#### Scenario: Adding a user who already has access

- GIVEN user B already has `project:editor` on proj-1
- WHEN user A searches for user B and clicks "Add"
- THEN the backend returns 409 Conflict (unique constraint on scope + project_id +
  user_id where role scope is `project`)
- AND the UI shows: "User already has access to this project"
- AND no duplicate binding is created

### Requirement: Project Ownership Transfer

The system SHALL support transferring project ownership via a dedicated API endpoint.
Because the RBAC hierarchy enforces a "strictly below" rule, `project:owner` cannot
grant `project:owner` through the standard role binding creation path. Project
ownership transfer is a separate operation.

#### API Endpoint

`POST /projects/{id}/transfer-ownership`

**Request body:**
```json
{"target_user_id": "string"}
```

**Response:** Updated project resource (200 OK)

**Error codes:**
- 403 Forbidden — caller is not the current `project:owner` or `platform:admin`
- 404 Not Found — target user does not exist
- 409 Conflict — target user is already `project:owner`

**Authorization:** The endpoint SHALL verify the caller is either:
1. The current `project:owner` on the target project, OR
2. A `platform:admin`

This check is independent of the generic `CanGrant` hierarchy — it is a dedicated
permission check, not a role-granting operation.

**Atomicity:** The operation SHALL execute in a single database transaction:
1. Create a `project:owner` binding for the target user
2. Downgrade the caller's binding to `project:editor` (only when the caller is
   the current `project:owner`; `platform:admin` callers are not downgraded)

The transaction SHALL acquire an advisory lock on the project to prevent concurrent
transfers. At no point during the transaction SHALL the project have zero owners.

The RBAC enforcement spec's sole-owner guard is satisfied because the new owner
binding is created before the old owner is downgraded.

#### UI Behavior

The transfer SHALL:

1. Be available only to the current `project:owner` or `platform:admin`
2. Appear as a "Transfer project ownership" action in the collaborator list,
   separate from the role selector
3. Require explicit confirmation with the target user's username typed to confirm

#### Scenario: Owner transfers project ownership

- GIVEN user A has `project:owner` on proj-1
- WHEN user A selects "Transfer project ownership" on user B's row
  (who is currently `project:editor`)
- THEN a confirmation dialog appears requiring user A to type user B's username
- WHEN user A types "userB" and confirms
- THEN `POST /projects/proj-1/transfer-ownership` is called with
  `{"target_user_id": "userB"}`
- AND user B receives `project:owner` on proj-1
- AND user A is downgraded to `project:editor` on proj-1
- AND the collaborator list updates to reflect the change

#### Scenario: Non-owner cannot transfer project ownership

- GIVEN user A has `project:editor` on proj-1
- WHEN user A views the collaborator list
- THEN no "Transfer project ownership" action is available

#### Scenario: Platform admin transfers ownership between other users

- GIVEN user A has `platform:admin` (no project-scoped binding on proj-1)
- AND user B has `project:owner` on proj-1
- WHEN user A selects "Transfer project ownership" on user C's row
- THEN user C receives `project:owner` on proj-1
- AND user B is downgraded to `project:editor` on proj-1
- AND user A retains their `platform:admin` global access (no project-scoped binding
  is created or modified for the admin)

### Requirement: User Search for Autocomplete

The users list endpoint (`GET /api/ambient/v1/users`) SHALL support a relaxed RBAC
filter for search queries. When a user with `project:editor` or higher on any project
performs a search query, the endpoint SHALL return matching users.

**Backend changes required:**
1. The users handler SHALL check if the caller has any project-scoped binding at
   `project:editor` level or above
2. If yes, allow the TSL search query but restrict the response to
   `fields=id,username,name` (using the existing `fields` parameter)
3. If no, fall back to the current "own record only" behavior

**Rate limiting:** The endpoint SHALL enforce server-side rate limiting of 10 requests
per 10 seconds per authenticated user on search queries to prevent user enumeration.

**Result cap:** Search results SHALL return at most 10 matching users per query.

The frontend SHALL use TSL syntax for the search:
`GET /users?search=username like 'jan%' or name like 'jan%'&fields=id,username,name`

The full user record (email, timestamps, etc.) SHALL remain restricted to the user
themselves and `platform:admin`.

#### Scenario: Project editor searches for users

- GIVEN user A has `project:editor` on proj-1
- WHEN user A calls `GET /users?search=username like 'j%' or name like 'j%'&fields=id,username,name`
- THEN users matching "j" in username or name are returned (max 10)
- AND the response includes only `id`, `username`, `name` fields
- AND no email or metadata is disclosed

#### Scenario: User with no project bindings cannot search

- GIVEN user A has zero project-scoped bindings
- WHEN user A calls `GET /users?search=username like 'jan%'`
- THEN only user A's own record is returned (existing behavior)

#### Scenario: Autocomplete triggers on first character

- GIVEN user A has `project:editor` on any project
- WHEN user A types 1 character in the search input
- THEN an API call is made with rate limiting
- AND matching results are shown in the Combobox dropdown

### Requirement: Project Cards Show Role and Shared Status

The project picker page (`/`) SHALL display the current user's role and shared status
on each project card.

**Query strategy:** A single `GET /role_bindings?search=scope = 'project'` query SHALL
fetch all project-scoped bindings in one paginated call. The UI joins client-side with
the project list to determine per-card role and shared status. This avoids N+1 queries.

Each card SHALL show:

- A **role pill/badge** indicating the user's role: Owner, Editor, or Viewer.
  These labels are project-scoped display names only — if credential or agent role
  pills are introduced later, they should use qualified labels (e.g., "Credential Owner")
- A **shared indicator** icon (`Users` from lucide) when the project has more than
  one user with project-scoped bindings
- An optional **avatar stack** showing up to 3 collaborator initials when shared

**States:**

- **Loading:** Skeleton placeholders of fixed dimensions for the role pill and
  avatar stack area to prevent layout shift
- **Error:** Cards render without sharing info (graceful fallback), not broken cards

#### Scenario: Owned project with collaborators

- GIVEN user A has `project:owner` on proj-1
- AND user B has `project:editor` on proj-1
- WHEN user A views the project picker
- THEN proj-1's card shows: role pill "Owner", shared icon, and user B's initials

#### Scenario: Shared project the user was added to

- GIVEN user A was granted `project:viewer` on proj-2 by another user
- WHEN user A views the project picker
- THEN proj-2's card shows: role pill "Viewer"

#### Scenario: Solo project

- GIVEN user A has `project:owner` on proj-3 with no other bindings
- WHEN user A views the project picker
- THEN proj-3's card shows: role pill "Owner", no shared icon, no avatar stack

### Requirement: Project Settings Page

The system SHALL provide a project settings page at `/{projectId}/settings`.
Access is via a **gear icon** in the nav header bar (next to the search and
notification controls), not a sidebar nav item.

> Note: `settings` must be removed from the `GLOBAL_ROUTES` set in
> `layout.tsx` since it is now a project-scoped route at `/{projectId}/settings`.

The settings page SHALL include:

- **General** tab: project name, description (editable by `project:editor`+;
  read-only for `project:viewer`). The `name` field refers to the existing
  Project model `name` field
- **Members** tab: the full `CollaboratorManager` component inline (same
  component used in the Share dialog)

**States:**

- **Loading:** Skeleton for form fields and collaborator list
- **Error:** Error banner with retry action
- **Empty Members:** Same as Share dialog empty state

#### Scenario: Editor edits project name

- GIVEN user A has `project:editor` on proj-1
- WHEN user A navigates to `/{proj-1}/settings`
- AND changes the project name to "New Name" and saves
- THEN the project name is updated via `PATCH /projects/{proj-1}`

#### Scenario: Viewer sees settings read-only

- GIVEN user A has `project:viewer` on proj-1
- WHEN user A navigates to `/{proj-1}/settings`
- THEN the General tab fields are read-only
- AND the Members tab shows the collaborator list without mutation controls

### Requirement: Settings Access via Nav Header

The nav header SHALL show a **gear icon** button when the user is on a project-scoped
page. Clicking it navigates to `/{projectId}/settings`. This is placed alongside the
search trigger, notification bell, and user menu.

The gear icon SHALL not appear on global pages (e.g., `/credentials`) or the project
picker page (`/`).

#### Scenario: Gear icon appears on project pages

- GIVEN user A is on `/{proj-1}/sessions`
- THEN the nav header shows a gear icon
- AND clicking it navigates to `/{proj-1}/settings`

#### Scenario: Gear icon hidden on global pages

- GIVEN user A is on `/credentials`
- THEN no gear icon is shown in the nav header

## Backend Prerequisites

The following backend changes are required before the sharing UI can be fully
implemented:

### RBAC Permission Update

The `project:viewer` role SHALL be updated to include `role_binding:read` and
`role_binding:list` permissions. Without these, viewers cannot fetch the collaborator
list for read-only display.

### Role Binding PATCH Authorization

The `PATCH /role_bindings/{id}` handler currently restricts non-admin callers to
patching only their own bindings (checking `isOwner` against the caller's username).
This SHALL be relaxed: if the caller has `project:owner` (or higher) on the same
project as the binding being patched, the role change SHALL be allowed, subject to
the existing `CanGrant` escalation check.

### Owner Transfer Endpoint

`POST /projects/{id}/transfer-ownership` as defined in the Project Ownership Transfer
requirement above.

### User Search RBAC Relaxation

The users handler SHALL implement the relaxed search filter as defined in the User
Search for Autocomplete requirement above.

## Data Model Notes

No new database tables are required. Project sharing is modeled entirely through
existing `RoleBinding` records with `scope=project`.

**Query pattern for collaborator list:**
`GET /role_bindings?search=scope = 'project' and project_id = '{projectId}'`
returns all project-scoped bindings. The UI resolves user names by batch-fetching
user records: `GET /users?search=id in ('{id1}','{id2}',...)&fields=id,username,name`
in a single call, then joining client-side.

**Query pattern for project card enrichment:**
A single `GET /role_bindings?search=scope = 'project'` query fetches all
project-scoped bindings visible to the caller. The UI groups by `project_id` to
determine per-card role and shared status. The current user's role is the binding
matching their user ID. Shared status is determined by binding count > 1.

**Frontend types needed:**
- `DomainUserSearchResult` — `{ id: string; username: string; name: string }`
- `UsersPort` interface for the search endpoint (following existing port/adapter
  pattern in `src/ports/`)
- `DomainRoleBinding` already exists in `src/domain/types.ts`; may need a resolved
  `roleName` field from a join with the roles list

**Relationship to session sharing:**
Project sharing governs project-scoped role bindings. Session sharing (per existing
docs at `docs/src/content/docs/features/session-sharing.md`) governs session-scoped
access. These are complementary, not overlapping.
