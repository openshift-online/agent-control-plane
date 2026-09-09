# Hypershell Runtime Status

## Purpose

Show workspace and session readiness when Hypershell manages runtime resources.

## Requirements

### Requirement: Workspace status

The workspace view SHALL show the sandbox service and its current state when
the runtime backend is Hypershell. It SHALL show a reported error as text.
A workspace gateway in `Running` state SHALL show that the service is still being
prepared until its status is `Ready`. Session `Running` status SHALL retain its
current meaning. An unknown status SHALL show "Status unavailable". A `Failed`
state without error details SHALL direct the user to their workspace administrator.
The status row SHALL omit the backend brand. The Resources tab SHALL identify
the backend.

#### Scenario: Gateway is not ready

- GIVEN a workspace uses Hypershell
- WHEN its gateway is being provisioned
- THEN the workspace shows that the sandbox service is being prepared

### Requirement: Session resources

The session view SHALL show the runtime state and reported error. The Resources
tab SHALL show assigned gateway, sandbox, and OpenShell workspace identifiers.
The OpenShell tab SHALL use the stored sandbox binding. It SHALL NOT require a
local Kubernetes namespace. Credential values and gateway account secrets SHALL
NOT be displayed. Assigned sandbox resources SHALL remain visible when the session
has no repositories. The repository empty state SHALL say "No repositories attached".
The session list and detail view SHALL continue to poll while runtime cleanup is
pending, including sessions whose phase is `Completed`, `Failed`, or `Stopped`.

#### Scenario: Managed sandbox without a local namespace

- GIVEN a session has a stored sandbox name and no Kubernetes namespace
- WHEN the user opens the session
- THEN the OpenShell logs and policy tabs are available
- AND the Resources tab shows its assigned sandbox

### Requirement: Accessible state changes

State changes SHALL use text and an accessible status region. Errors SHALL use
an alert region with the danger text and background contrast tokens. Long resource
identifiers and error text SHALL wrap on small screens. The session tab list SHALL
scroll horizontally at a viewport width of 320 pixels. All tabs SHALL remain
available by keyboard.

### Requirement: Log connection recovery

Sandbox logs SHALL stop automatic reconnect attempts after five failed retries.
They SHALL clear the reconnecting state and show an error with a Retry button,
including when no log entries were received. Retry SHALL start a new connection
attempt. Stopping the session SHALL cancel pending reconnect timers.

#### Scenario: Log endpoint is unavailable

- GIVEN a running session has received no sandbox logs
- WHEN five reconnect attempts fail
- THEN the view shows a connection error and a Retry button
- AND it SHALL NOT continue to show a waiting or reconnecting state
