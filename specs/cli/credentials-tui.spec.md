# TUI Credential Management

## Purpose

The `acpctl ambient` interactive TUI SHALL provide credential management with full feature parity to the ambient-ui's Credentials view. This covers a credential registry table (`:credentials`), full CRUD lifecycle, token rotation, and a credential-bindings view (`:credentialbindings`) for managing per-project and per-agent access grants.

Binding semantics follow `credential-binding-enforcement.spec.md`. This spec covers project-level and agent-level bindings only. Global bindings (`project_id=NULL`, `agent_id=NULL`) require `platform:admin` and are not exposed in the TUI — they are an admin operation performed via the API or `acpctl` CLI directly.

### Terminology

- **credential-bindings view** — A filtered projection of the global RoleBinding resource, showing only `scope=credential` RoleBindings filtered by `credential_id`. Not a separate Kind.
- **inherited row** — A synthesized display row representing effective agent access derived from a project-level binding. The agent has no explicit agent-level binding **for this credential**, but its project has a project-level binding for the credential. Inherited rows do not correspond to stored RoleBinding records. An agent may inherit one credential from a project while having a direct binding for another.
- **`credential:viewer`** — The user-grantable role used in `scope=credential` bindings to grant access to a credential. Distinct from `credential:token-reader` (an internal role granted by the control plane to session service accounts at runtime, not shown in the TUI).

## Requirements

### Requirement: Credentials Table View

The TUI SHALL provide a `:credentials` view (alias `:cred`) displaying all credentials in a `ResourceTable`. Credentials are global resources — the view SHALL NOT be scoped to a project.

The table SHALL display the following columns:

| Column | Width | Content |
|--------|-------|---------|
| NAME | 20 | `credential.name` |
| PROVIDER | 12 | `credential.provider` (github, gitlab, jira, google, kubeconfig) |
| DESCRIPTION | 32 | `credential.description`, truncated |
| BINDINGS | 10 | Count of `scope=credential` RoleBindings referencing this credential |
| AGE | 8 | Relative time since `created_at` |

The view SHALL support standard table interactions: filter (`/`), column sort (`shift-n` for name, `shift-a` for age), and copy ID (`c`).

The BINDINGS count SHALL be computed from cached `scope=credential` RoleBindings fetched alongside the credential list.

#### Scenario: Navigate to credentials view

- GIVEN the TUI is running
- WHEN the user types `:cred` and presses Enter
- THEN the credentials table renders with all credentials
- AND the nav stack shows `<credentials>`

#### Scenario: Filter credentials by name

- GIVEN the credentials view is active with credentials "github-pat", "jira-cloud", "gitlab-ci"
- WHEN the user types `/git` and presses Enter
- THEN only "github-pat" and "gitlab-ci" are visible

#### Scenario: Credentials view shows binding counts

- GIVEN credential "github-pat" has 3 RoleBindings with `scope=credential`
- AND credential "jira-cloud" has 0 RoleBindings
- WHEN the credentials table renders
- THEN "github-pat" shows "3" in the BINDINGS column
- AND "jira-cloud" shows "0" in the BINDINGS column

### Requirement: Credential Create

The TUI SHALL support creating credentials via the `n` key, which opens a form overlay.

The form SHALL include the following fields:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| Provider | Select | Yes | Options: github, gitlab, jira, google, kubeconfig |
| Name | Text | Yes | |
| Token | Password | No | Input MUST NOT echo characters |
| URL | Text | No | |
| Email | Text | No | |
| Description | Text | No | |

On successful creation, the TUI SHALL refresh the credentials table and display an info message.

#### Scenario: Create a credential

- GIVEN the credentials view is active
- WHEN the user presses `n`
- THEN a form overlay appears with Provider, Name, Token, URL, Email, Description fields
- WHEN the user fills Provider=github, Name=github-pat, Token=ghp_xxx and submits
- THEN the credential is created via `POST /credentials`
- AND the info line shows "Credential created: github-pat"
- AND the table refreshes to include the new credential

#### Scenario: Create form requires provider and name

- GIVEN the create form is open
- WHEN the user submits without filling Provider or Name
- THEN the form displays validation errors for the required fields
- AND the credential is NOT created

### Requirement: Credential Detail

The TUI SHALL support viewing credential details via the `d` key, which opens a detail view.

The detail view SHALL display the following key-value pairs: ID, Name, Provider, Description, URL, Email, Created, Updated. It SHALL NOT display the token value.

The detail view SHALL include a "Bindings" section listing all `scope=credential` RoleBindings for this credential, showing target type (project/agent), target name, and binding state (direct/inherited).

#### Scenario: Describe a credential

- GIVEN the credentials view is active with "github-pat" selected
- WHEN the user presses `d`
- THEN the detail view shows the credential's metadata
- AND a Bindings section lists all associated RoleBindings

#### Scenario: Token never shown in detail

- GIVEN the user describes credential "github-pat"
- WHEN the detail view renders
- THEN no token value is displayed anywhere in the output

### Requirement: Credential Edit

The TUI SHALL support editing credentials via the `e` key, which opens the credential as JSON in the user's `$EDITOR`. On save, changed fields SHALL be PATCHed via the API.

The JSON presented to the editor SHALL NOT include the `token` field.

#### Scenario: Edit credential description

- GIVEN the credentials view is active with "github-pat" selected
- WHEN the user presses `e`
- THEN $EDITOR opens with the credential's JSON (excluding token)
- WHEN the user changes the description and saves
- THEN `PATCH /credentials/{id}` is called with the changed fields
- AND the info line shows "Credential updated: github-pat"

### Requirement: Credential Delete

The TUI SHALL support deleting credentials via `ctrl-d`, which shows a confirmation dialog before deletion.

#### Scenario: Delete a credential

- GIVEN the credentials view is active with "github-pat" selected
- WHEN the user presses `ctrl-d`
- THEN a dialog asks "Delete credential github-pat?"
- WHEN the user confirms
- THEN `DELETE /credentials/{id}` is called
- AND the table refreshes
- AND the info line shows "Credential deleted: github-pat"

#### Scenario: Cancel credential deletion

- GIVEN the delete confirmation dialog is showing
- WHEN the user presses Escape or selects Cancel
- THEN the credential is NOT deleted
- AND the dialog closes

### Requirement: Token Rotation

The TUI SHALL support rotating a credential's token via the `t` key, which prompts for a new token value.

The prompt input SHALL NOT echo characters (password-style input).

#### Scenario: Rotate token

- GIVEN the credentials view is active with "github-pat" selected
- WHEN the user presses `t`
- THEN a prompt appears: "New token for github-pat:"
- AND the input does not echo typed characters
- WHEN the user enters a new token and presses Enter
- THEN `PATCH /credentials/{id}` is called with the new secret value
- AND the info line shows "Token rotated for github-pat"

### Requirement: Credential JSON Copy

The TUI SHALL support copying a credential's JSON representation to the clipboard via the `y` key. The JSON SHALL NOT include the `token` field.

#### Scenario: Copy credential JSON

- GIVEN the credentials view is active with "github-pat" selected
- WHEN the user presses `y`
- THEN the credential's JSON (excluding token) is copied to the clipboard
- AND the info line shows "Copied to clipboard"

### Requirement: Drill into Credential Bindings

The TUI SHALL support drilling from a credential into its bindings view via `Enter`.

#### Scenario: Drill into bindings

- GIVEN the credentials view is active with "github-pat" selected
- WHEN the user presses Enter
- THEN the view switches to `:credentialbindings` scoped to "github-pat"
- AND the nav stack shows `<credentials> <credentialbindings>`

### Requirement: Credential Bindings Table View

The TUI SHALL provide a `:credentialbindings` view (alias `:cb`) displaying `scope=credential` RoleBindings for a specific credential, plus synthesized inherited rows. This view requires a credential context — it is reached by drilling from the credentials view or by typing `:cb` when a credential is in context.

The table SHALL display the following columns:

| Column | Width | Content |
|--------|-------|---------|
| CREDENTIAL | 20 | Credential name |
| TYPE | 8 | "project" or "agent" |
| TARGET | 20 | Project name or agent name |
| STATE | 12 | "direct" or "inherited" |
| AGE | 8 | Relative time since binding `created_at` (empty for inherited rows) |

A binding's STATE SHALL be determined as follows:
- A project-level binding (`agent_id` NULL) is always "direct".
- An agent-level binding (`agent_id` set) is "direct".
- For each project that has a project-level binding for this credential, the view SHALL fetch the agents belonging to that project. Any agent that lacks an explicit agent-level binding SHALL be displayed as an inherited row with STATE="inherited". Inherited rows have no backing RoleBinding record — they represent effective access.

#### Scenario: View bindings for a credential

- GIVEN credential "github-pat" has a project-level binding to "platform"
- AND credential "github-pat" has an agent-level binding to "pr-reviewer" in "platform"
- WHEN the credential-bindings view renders for "github-pat"
- THEN the table shows:
  - Row: CREDENTIAL=github-pat, TYPE=project, TARGET=platform, STATE=direct
  - Row: CREDENTIAL=github-pat, TYPE=agent, TARGET=pr-reviewer, STATE=direct

#### Scenario: Inherited binding display

- GIVEN credential "github-pat" has a project-level binding to "platform"
- AND agent "bug-fixer" belongs to "platform" but has no explicit agent binding
- WHEN the credential-bindings view renders for "github-pat"
- THEN the table shows:
  - Row: CREDENTIAL=github-pat, TYPE=project, TARGET=platform, STATE=direct
  - Row: CREDENTIAL=github-pat, TYPE=agent, TARGET=bug-fixer, STATE=inherited

#### Scenario: Navigate to bindings without context

- GIVEN no credential is in context
- WHEN the user types `:cb` and presses Enter
- THEN the info line shows "No credential context — drill into a credential first"
- AND the view does not change

### Requirement: Bind Credential to Project

The TUI SHALL support binding a credential to a project via the `b` key in the credential-bindings view. The user SHALL be prompted to select or enter a project name.

The binding SHALL be created as a RoleBinding with `role_id=credential:viewer`, `scope=credential`, and the selected `credential_id` and `project_id`. The `agent_id` SHALL be NULL.

Authorization is enforced server-side: the caller must hold `credential:owner` on the credential and `project:editor` or higher on the target project. The TUI SHALL display the API error message on 403 Forbidden.

#### Scenario: Bind to project

- GIVEN the credential-bindings view is active for "github-pat"
- WHEN the user presses `b`
- THEN a prompt asks for the project name
- WHEN the user enters "platform"
- THEN a RoleBinding is created: `{role_id: "credential:viewer", scope: "credential", credential_id: <id>, project_id: "platform"}`
- AND the bindings table refreshes
- AND the info line shows "github-pat bound to project platform"

#### Scenario: Bind denied by insufficient permissions

- GIVEN the credential-bindings view is active for "github-pat"
- AND the user does not hold `credential:owner` on "github-pat"
- WHEN the user presses `b` and enters "platform"
- THEN the API returns 403 Forbidden
- AND the info line shows the error message

### Requirement: Bind Credential to Agent

The TUI SHALL support binding a credential to a specific agent via the `a` key in the credential-bindings view. The user SHALL be prompted for both a project name and an agent name.

The binding SHALL be created as a RoleBinding with `role_id=credential:viewer`, `scope=credential`, and the selected `credential_id`, `project_id`, and `agent_id`.

Authorization requirements are the same as project binding: the caller must hold `credential:owner` on the credential and `project:editor` or higher on the target project. The agent must belong to the specified project (enforced server-side).

#### Scenario: Bind to agent

- GIVEN the credential-bindings view is active for "github-pat"
- WHEN the user presses `a`
- THEN a prompt asks for the project name
- WHEN the user enters "platform"
- THEN a prompt asks for the agent name
- WHEN the user enters "pr-reviewer"
- THEN a RoleBinding is created: `{role_id: "credential:viewer", scope: "credential", credential_id: <id>, project_id: "platform", agent_id: "pr-reviewer"}`
- AND the bindings table refreshes
- AND the info line shows "github-pat bound to agent pr-reviewer in project platform"

### Requirement: Unbind (Revoke Binding)

The TUI SHALL support removing a binding via `ctrl-d` on a selected binding row in the credential-bindings view. A confirmation dialog SHALL be shown before deletion.

Inherited rows (STATE=inherited) SHALL NOT be deletable — they represent effective access from a project-level binding, not a stored RoleBinding.

Authorization is enforced server-side: unbinding requires only `project:editor` on the binding's project (not `credential:owner`). This allows project editors to remove any credential from their project regardless of who bound it.

#### Scenario: Unbind a direct binding

- GIVEN the credential-bindings view shows a direct project binding for "platform"
- WHEN the user selects the binding and presses `ctrl-d`
- THEN a confirmation dialog shows "Unbind github-pat from project platform?"
- WHEN the user confirms
- THEN `DELETE /role_bindings/{id}` is called
- AND the bindings table refreshes

#### Scenario: Cannot unbind inherited binding

- GIVEN the credential-bindings view shows an inherited agent binding for "bug-fixer"
- WHEN the user selects the inherited row and presses `ctrl-d`
- THEN the info line shows "Cannot unbind inherited access — remove the project binding instead"
- AND no deletion occurs

### Requirement: Hotkey Hints

The TUI SHALL register hotkey hints for both views in the header hint area.

Credentials view hints:
- Resource: `d` Describe, `e` Edit, `n` New, `t` Rotate Token, `y` JSON, `ctrl-d` Delete
- Navigation: `Enter` View bindings, `Esc` Back, `q` Back

Credential-bindings view hints:
- Resource: `d` Describe, `ctrl-d` Unbind, `b` Bind Project, `a` Bind Agent
- Navigation: `Esc` Back to credentials, `q` Back

#### Scenario: Hints displayed in credentials view

- GIVEN the credentials view is active
- WHEN the header renders
- THEN hotkey hints show: d Describe, e Edit, n New, t Rotate Token, y JSON, ctrl-d Delete, Enter View bindings

### Requirement: Token Security

The TUI SHALL NOT display credential tokens in any view, detail output, JSON copy, or editor payload. Token values SHALL only be accepted as input during creation (`n`) and rotation (`t`), and SHALL NOT be echoed to the terminal.

#### Scenario: Token excluded from all outputs

- GIVEN credential "github-pat" has a stored token
- WHEN any of: detail view (`d`), JSON copy (`y`), or editor (`e`) renders the credential
- THEN the `token` field is absent from the output

### Requirement: API Error Handling

The TUI SHALL display API error messages for failed operations. On 403 Forbidden, the info line SHALL show the permission error. On other errors (404, 409, 500), the info line SHALL show the error message returned by the API.

#### Scenario: Permission denied on create

- GIVEN the user submits a credential create form
- AND the API returns 403 Forbidden
- THEN the info line shows the error message
- AND the credentials table is NOT modified

#### Scenario: Delete fails with active bindings

- GIVEN the user confirms deletion of credential "github-pat"
- AND the API returns an error (credential has active bindings)
- THEN the info line shows the error message
- AND the credential remains in the table

### Requirement: Auto-Refresh

The credentials and credential-bindings views SHALL auto-refresh on the standard poll interval (same as other resource tables). Stale data SHALL be indicated in the header when the refresh interval is exceeded.

#### Scenario: Auto-refresh credentials

- GIVEN the credentials view is active
- WHEN the poll interval elapses
- THEN the credential list and binding counts are re-fetched
- AND the table updates with fresh data
