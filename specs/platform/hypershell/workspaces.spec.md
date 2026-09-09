# Hypershell Workspace Resources

## Purpose

ACP Projects use Hypershell gateways to run sessions. ACP stores application
state in PostgreSQL. Hypershell owns gateway infrastructure.

## Requirements

### Requirement: Workspace provisioning

When Hypershell execution is enabled, each new Project SHALL receive one gateway.
ACP SHALL report Pending, Provisioning, Ready, Degraded, Deleting, or Deleted
runtime status. Sessions SHALL wait until the gateway and its identity are ready.
Only the control plane SHALL change runtime references and status.

#### Scenario: Recover a lost response

- GIVEN a gateway create operation succeeds but its response is lost
- WHEN ACP retries with the same project incarnation and instance identity
- THEN Hypershell SHALL return the same gateway
- AND another caller SHALL NOT acquire that gateway through this reference

### Requirement: Durable ownership

ACP SHALL retain gateway references after Project deletion until cleanup succeeds.
It SHALL retry failed cleanup. It SHALL delete only gateways that it owns.
It SHALL NOT require Kubernetes access to the gateway cluster.

#### Scenario: Delete during an outage

- GIVEN a Project has running sessions and Hypershell is unavailable
- WHEN the Project is deleted
- THEN ACP SHALL retain pending cleanup state
- AND SHALL stop sessions and delete owned infrastructure after recovery

### Requirement: API compatibility

Existing Project creation clients SHALL continue to work. Runtime fields SHALL
be read-only for users and present in REST, gRPC, and generated SDK responses.
Deployments without the Hypershell feature enabled SHALL retain their existing
execution selection. Configuration SHALL select the Hypershell instance, gateway
images, trust, and endpoints.

#### Scenario: User attempts to change a gateway

- GIVEN a user can edit a Project
- WHEN the user submits control-plane runtime fields
- THEN the API SHALL reject the runtime write or ignore read-only fields
- AND the recorded gateway SHALL remain unchanged
