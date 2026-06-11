# Agentic Session Lifecycle

Detailed flow showing how an agentic session progresses from creation through execution to completion and cleanup.

## Lifecycle Diagram

```mermaid
--8<-- "session-lifecycle.mmd"
```

## Phase Breakdown

### Phase 1: Session Creation (Steps 1-3)
**Duration**: Milliseconds

The process starts when a user submits a session request:

1. **Frontend Submission**: User creates a new session with:
   - Prompt or task description
   - Repository selection
   - Model choice
   - Timeout configuration

2. **API Validation**: API server validates:
   - User authentication token is valid
   - Request format is correct
   - User has access to specified namespace (RBAC)
   - Required resources are available

3. **Session Creation**: API server persists session to PostgreSQL with:
   - prompt, repos, model, timeout, and other configuration

### Phase 2: Kubernetes Reaction (Steps 4-7)
**Duration**: 5-30 seconds

Control plane orchestrates job creation:

4. **Event Received**: Control plane receives session event via gRPC watch stream
5. **Namespace Ready**: Control plane provisions namespace if needed
6. **Job Creation**: Control plane creates a Kubernetes Job with container image, environment variables, volume mounts, and resource requests
7. **Job Scheduling**: Kubernetes scheduler assigns the job to an available node

### Phase 3: Pod Initialization (Steps 8-9)
**Duration**: 5-15 seconds

The execution environment starts:

8. **Pod Spawning**: Kubelet creates the execution pod
9. **Runner Initialization**: Claude Code Runner starts setup phase

### Phase 4: Task Execution (Steps 10-11)
**Duration**: Seconds to minutes (depends on task)

The AI reasoning and execution happens:

10. **Prompt Processing**: Claude Code CLI receives the user's prompt
11. **Execution**: Multi-stage process with Claude reasoning and MCP tool invocations

### Phase 5: Results & Completion (Steps 12-14)
**Duration**: Seconds

Results are finalized and cleanup proceeds.

### Phase 6: Frontend Update (Steps 15-17)
**Duration**: Milliseconds

User sees results via WebSocket or polling.

## Error Handling

### Execution Error Path
If the Claude Code CLI encounters an error:
1. Error is captured by the runner
2. Session is updated with error message and stack trace
3. Session phase set to `Failed`
4. Cleanup proceeds normally

### Timeout Handling
If execution exceeds the configured timeout:
1. Control plane monitors elapsed time
2. When threshold reached, control plane forces pod termination
3. Updates session status to Timeout`
4. Resources are freed immediately

## Typical Execution Times

| Phase | Duration | Notes |
|-------|----------|-------|
| Session Creation | < 100ms | Synchronous API call |
| Job Scheduling | 5-30s | Kubernetes scheduling + pod pull/init |
| Code Analysis | 10-60s | Claude reads repositories, analyzes structure |
| Task Execution | 30s-30m | Depends on task complexity and tool usage |
| Cleanup | < 10s | Pod termination and resource release |
| **Total** | **1-30+ min** | Highly variable based on task |

## When to Reference This Diagram

Use this diagram when:
- Understanding how sessions execute end-to-end
- Troubleshooting stuck or failing sessions
- Designing new session features
- Setting appropriate timeout values
- Explaining the execution model to users
- Debugging operator behavior
