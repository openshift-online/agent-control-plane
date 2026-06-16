---
name: acp-review-guidance
description: >
  ACP-specific review standards to apply alongside the upstream pr-review skill.
  Use when reviewing PRs in this repository. Loads project conventions, security
  requirements, and component-specific checklists that supplement the fleet
  pr-review workflow.
---

# ACP Review Guidance

Apply these standards **in addition to** the fleet `pr-review` skill when reviewing PRs in this repository. The `pr-review` skill defines the review process (summarize, worktree, context, analyze, report). This skill defines **what to check** during Steps 3 and 4 of that process.

## Step 3 Supplement: Mandatory Context Files

Before analyzing any PR in this repo, load all of the following:

1. `CLAUDE.md`
2. `specs/standards/security/security.spec.md`
3. `specs/standards/control-plane/conventions.spec.md`

## Step 4 Supplement: ACP Review Checklists

### Go Backend

- [ ] All user operations use `GetK8sClientsForRequest(c)`, never service account fallback
- [ ] No tokens in logs — use `len(token)` for diagnostics
- [ ] Type-safe unstructured access (`unstructured.NestedMap`, not direct assertions)
- [ ] No `panic()` in production code — return `fmt.Errorf` with context
- [ ] Errors wrapped: `fmt.Errorf("context: %w", err)`
- [ ] `errors.IsNotFound` handled for 404 scenarios
- [ ] OwnerReferences set on child resources (Jobs, Secrets, PVCs)

### React/TypeScript Frontend

- [ ] Zero `any` types — use proper types, `unknown`, or generic constraints
- [ ] Shadcn UI components only — no custom buttons, inputs, dialogs
- [ ] React Query for all data operations — no manual `fetch()` in components
- [ ] `type` preferred over `interface`
- [ ] Single-use components colocated with their page
- [ ] Loading and error states handled
- [ ] Query keys include all relevant parameters

### Security (All Components)

- [ ] RBAC check performed before resource access
- [ ] No tokens or secrets in logs or error messages
- [ ] Input validated (K8s DNS labels, URL parsing)
- [ ] Log injection prevented — no raw newlines in logged user input
- [ ] Generic error messages to users, detailed logs server-side
- [ ] Container SecurityContext: `AllowPrivilegeEscalation: false`, `Drop: ALL`

### General

- [ ] No `panic()` in production Go code
- [ ] No `any` types in frontend TypeScript
- [ ] Feature flags gate new features (Unleash)
- [ ] OwnerReferences on all new K8s child resources
- [ ] New API endpoints have corresponding frontend proxy routes
- [ ] PostgreSQL for persistent storage (not files)

## Severity Classification

- **Blocker** — Must fix. Security vulnerabilities, data loss, SA misuse, token leaks
- **Critical** — Should fix. RBAC bypasses, missing error handling, `any` types, `panic()` in handlers
- **Major** — Important. Architecture violations, missing tests, performance concerns
- **Minor** — Nice-to-have. Style, docs gaps
HEREDOC < /dev/null
