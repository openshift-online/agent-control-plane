# Synthetic Work Packet: Codebase Release Readiness Assessment

## Target

An internal devtooling codebase that is maintained as both software and a
managed program. It is not product-facing.

## Objective

Assess the codebase for release readiness. The team should produce a concise
operating picture, role-specific evidence, a human decision queue, and next
recommended actions.

The assessment should cover code health, runtime and demo readiness, CI,
security, documentation, release gates, unresolved follow-ups, and decisions
that need a human maintainer.

## Team Roles

### Lead Maintainer

Owns the operating picture, prioritization, work routing, branch state, release
readiness, risks, unresolved follow-ups, and human decision queue. Lead
Maintainer manages Code Maintainer, Runtime Maintainer, and Quality Maintainer.

### Code Maintainer

Owns implementation quality across backend, frontend, CLI, runner, manifests,
repo conventions, API/SDK drift, bug investigation, refactors, candidate fixes,
and code-review findings.

### Runtime Maintainer

Owns dev, test, and runtime surfaces: Kind, OpenShell, runners, sessions,
manifests, images, local/demo readiness, local cluster health, session startup,
and sandbox cleanup.

### Quality Maintainer

Owns tests, CI, security checks, docs verification, release gates, flakes,
coverage gaps, RBAC/auth safety, docs freshness, changelog or release notes, and
the final safe-to-proceed evidence report.

## Suggested First Prompt

Lead Maintainer, coordinate the codebase maintainers team on a release readiness
assessment for this internal devtooling codebase. Ask Code Maintainer to inspect
implementation risks, Runtime Maintainer to verify local/demo/runtime health,
and Quality Maintainer to check CI, security, docs, and release gates. Produce
the human decision queue and next recommended actions.

## Assessment Areas

1. Branch and worktree state
2. Recent changes and unresolved follow-ups
3. Backend, frontend, CLI, runner, manifest, and SDK/API drift risks
4. Tests, coverage gaps, flakes, and CI status
5. Security, RBAC/auth, token handling, and secret handling
6. Kind, OpenShell, runner, session startup, image, and sandbox cleanup health
7. Demo readiness and observable behavior proof
8. Documentation freshness, examples, changelog, and release notes
9. Human decisions needed before merge, release, or deployment

## Expected Output

- Current operating picture
- Role-by-role evidence
- Release blockers
- Non-blocking residual risks
- Human decision queue
- Next recommended actions with owners
- Final `safe to proceed` or `not safe to proceed` recommendation
