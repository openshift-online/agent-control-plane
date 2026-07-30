---
name: jira-create
description: >
  Create Jira issues in ENGPROD for Agent Control Plane (acp component).
  Supports single interactive creation with duplicate detection, specialist-drafted
  content, and quality grading — plus batch creation from bullet lists.
  Use whenever work needs tracking in Jira: creating stories, filing bugs, logging
  tasks, opening spikes, creating epics, or batch ticket creation.
  Triggers on: "create jira", "log jira", "file a bug", "new ticket",
  "open a story", "jira issue", "track this work", "create a ticket",
  "create tickets", "batch tickets", "log these items".
---

# Jira Create — Agent Control Plane

Create well-structured Jira issues in the **ENGPROD** project with the **acp** (Agent Control Plane) component pre-filled. Every issue is built to be agent-actionable from a cold start — meaning another agent (or human) can pick it up and start working immediately without asking clarifying questions.

Includes duplicate detection, specialist-drafted content, activity type defaults, and a quality grading gate for single tickets. Supports batch creation from markdown bullet lists.

## User Input

```text
$ARGUMENTS
```

Consider the user input before proceeding (if not empty).

## Recognizing Single vs Batch Mode

**Single ticket** (default): The input is a sentence, paragraph, or block of text describing one piece of work. Follow the interactive Instructions below.

**Batch mode**: The input contains a markdown bullet list (lines starting with `- ` or `* `). Each top-level bullet becomes a separate ticket. Sub-bullets provide context for that ticket's description. Batch mode skips the interactive interview — use sub-bullet context and reasonable defaults, then confirm the full batch before creating.

When batch mode is detected, skip to **Batch Execution** at the end of this document.

## Instructions

Follow these steps in order for single-ticket mode. Use `AskUserQuestion` for each step unless `$ARGUMENTS` already provides enough context (see Fast Path below). Do NOT skip steps or guess values without user confirmation.

### Fast Path from $ARGUMENTS

When `$ARGUMENTS` is non-empty and descriptive:

1. Parse type prefix if present: `[Bug]`, `[Task]`, `[Spike]`, `[Epic]`, `[Story]` → set issue type and summary.
2. If type and summary are clear, skip Step 1 (Issue Type) and proceed to Step 2 (Duplicate Search).
3. Pass the full `$ARGUMENTS` context to the specialist agent in Step 3 so it can draft without re-asking known details.

### Step 1: Issue Type

Use `AskUserQuestion` to ask the user what type of issue to create (skip if inferred from `$ARGUMENTS`):

- **Story** — User-facing functionality with acceptance criteria
- **Bug** — Defect report with reproduction steps
- **Task** — Internal technical work, non-user-facing
- **Spike** — Research, investigation, or proof-of-concept
- **Feature** — Significant customer-facing capability
- **Epic** — Large body of work spanning multiple sprints
- **Initiative** — Internal capability or architectural improvement; typically ~6 months, or no larger than a single Quarter/Release
- **Outcome** — Strategic business result tied to corporate objectives
- **Sub-task** — Child task under an existing issue
- **Risk** — Potential hazard that could block or delay work
- **Ticket** — Stakeholder request for intake and triage

### Step 2: Duplicate Search

Before collecting any other fields, search for similar open issues using JQL.

Run: `issuetype = [selected type] AND project = ENGPROD AND summary ~ "[keywords from user's intent]" AND status != Closed ORDER BY updated DESC`

If similar issues are found, present them to the user and ask whether to proceed with a new issue or use an existing one. If no duplicates are found, continue.

### Step 3: Delegate to Specialist Agent

Based on the issue type selected, launch the appropriate specialist agent to help craft the content. The agent should help formulate the summary, description, and any type-specific fields.

Pass ACP project context to the specialist:
- **Repo**: openshift-online/agent-control-plane
- **Jira component**: acp
- **ACP code components**: ambient-api-server, ambient-control-plane, ambient-ui, ambient-runner, ambient-mcp, ambient-cli, ambient-sdk, manifests, docs
- Use the ACP description template (see **ACP Description Template** below)

| Issue Type | Agent | Template to reference |
|------------|-------|-----------------------|
| Story | `story-specialist` | `skills/story-specialist/template.md` |
| Bug | `bug-specialist` | `skills/bug-specialist/template.md` |
| Task | `task-specialist` | `skills/task-specialist/template.md` |
| Spike | `spike-specialist` | `skills/spike-specialist/template.md` |
| Feature | `feature-specialist` | `skills/feature-specialist/template.md` |
| Epic | `epic-specialist` | `skills/epic-specialist/template.md` |
| Initiative | `initiative-specialist` | `skills/initiative-specialist/template.md` |
| Outcome | `outcome-specialist` | `skills/outcome-specialist/template.md` |
| Sub-task | `task-specialist` | `skills/task-specialist/subtask-template.md` |
| Risk | `risk-specialist` | `skills/risk-specialist/template.md` |
| Ticket | `ticket-specialist` | `skills/ticket-specialist/template.md` |

The agent should return a proposed **summary** and **description**. Present them to the user for approval or editing via `AskUserQuestion`.

### Step 3b: Type-Appropriateness Check

For **Outcome, Feature, and Initiative** issue types only, evaluate the drafted summary and description against the signal tables in `skills/jira-specialist/SKILL.md` (Type-Appropriateness Check section). Now that there is actual content to assess, ask 1–2 targeted clarifying questions if any signals are present.

| Selected Type | Key clarifying question |
|---|---|
| **Outcome** | "Does this describe a measurable change in human behavior or business result that would warrant a press-release-level announcement — or is it primarily a product capability or internal improvement?" |
| **Feature** | "Is the primary beneficiary an external customer (not a Red Hat associate), and is there a clear customer value statement beyond grouping Epics?" |
| **Initiative** | "Is the result primarily an internal capability improvement for Red Hat associates (not a customer-facing product feature), within a ~6 month timeframe, or no larger than a single Quarter/Release?" |

If the drafted content raises a type mismatch signal, recommend the more appropriate type and ask whether to switch. If switching, return to Step 3 with the correct type. If the type is confirmed correct (intentional scope), note it and proceed.

For all other types (Story, Bug, Task, Spike, Epic, Sub-task, Risk, Ticket), skip this step.

### Step 4: Structured Field Interview

Use `AskUserQuestion` to collect all remaining required fields in **one pass** — group logically (up to 4 questions per call).

**Before collecting any fields, ask whether this issue has a parent** (e.g., an Epic for a Story, an Initiative for an Epic, a parent Task for a Sub-task). Asking early lets you inherit Activity Type from the parent rather than asking the user to re-enter it.

If a parent key is provided:
1. Fetch the parent issue using the Jira MCP tool.
2. Read its `customfield_10464` value (Activity Type).
3. If the parent has an Activity Type set, automatically inherit it — do not ask the user to select one. Inform them: _"Activity Type copied from parent [KEY]: [value]."_ Give them the option to override.
4. If the parent has no Activity Type set, fall through to the normal Activity Type selection below.

If no parent is provided, apply ACP Activity Type defaults automatically — do not prompt unless the user wants to override:

| Issue context | Activity Type | Option ID |
|---------------|---------------|-----------|
| Bug, tech debt, stability | Quality / Stability / Reliability | 10608 |
| Everything else | Future Sustainability | 10606 |

**Priority** (default: Normal):
- Blocker
- Critical
- Major
- Normal (Recommended)
- Minor
- Trivial

Jira field key: `customfield_10464`. Set via MCP as `"customfield_10464": {"id": "<option_id>"}`.

| Activity Type | Option ID | Best for |
|---------------|-----------|----------|
| Associate Wellness & Development | 10604 | Onboarding, training, team health |
| BU Features | 10605 | Business unit feature commitments |
| Future Sustainability | 10606 | Tooling, architecture, upstream |
| Incidents & Support | 10607 | Escalations, customer support |
| Quality / Stability / Reliability | 10608 | Bugs, tech debt, toil reduction |
| Security & Compliance | 10609 | CVEs, vulnerabilities, compliance |
| Product / Portfolio Work | 10610 | Features, outcomes, strategic work |

**Original Estimate** (e.g., '2h', '1d', '30m')

**Story Points** (default: 1) — MUST always be prompted for via `AskUserQuestion`. If the user does not provide a value, use 1.

### Step 5: Collect Categorization Fields

Apply ACP defaults — only ask if the user wants to override:

**Component**: Default to **acp**. Do not ask unless the user indicates a different Jira component is needed.

**Labels**: Default to **team:acp**. Ask only if the user wants additional labels.

**Target Version** — Ask for the target version (fetch available versions using the registered Jira MCP tools if needed). Use `customfield_10855` for target version (NOT fix version for new/in-progress issues).

### Step 6: Parent / Linking

If a parent was already provided in Step 4, use that key here — do not ask again. Otherwise, use `AskUserQuestion` to ask if there is a parent or related issue.

- If **Sub-task**: The parent issue key is required. Set the `parent` field on create.
- If **Risk**: Ask which issue(s) this risk affects — link using the "caused by" link type.
- If **any other type** and a parent is provided: Create the issue first, then link it. Ask which link type to use (Blocks, Depends, Related, Incorporates, etc.).
- If **Epic**: Ask for an `epic_name` (required for Epics).

For related links, use `"Related"` as the link type — not `"Relates"` (wrong name silently fails).

### Step 7: Quality Grade

Before creating, evaluate the planned issue content against the matching template (from the specialist's `template.md`) and the ACP description template below.

Score the content on these 5 dimensions (see `skills/jira-report/SKILL.md` for the full grading rubric):

| Dimension | Weight |
|-----------|--------|
| Completeness | 25% |
| Linkage | 20% |
| Clarity | 25% |
| Sizing / Scoping | 15% |
| Measurability | 15% |

Assign an overall grade: **[A] READY**, **[B] MINOR GAPS**, **[C] NEEDS WORK**, or **[D] NOT READY**.

- **[A] or [B]**: Proceed to confirmation.
- **[C] or [D]**: Present the grade and specific gaps to the user. Ask whether to improve the content or proceed anyway. Do not proceed without explicit confirmation.

### Step 8: Confirm and Create

Before calling the create MCP tool, display a summary of ALL fields and the quality grade. Ask for confirmation.

Always set:
- `project_key`: ENGPROD
- `components`: acp
- `labels`: team:acp (plus any additional labels the user requested)
- `security_level`: "Red Hat Employee" (ID: `10034`)
- `assignee`: from personal config if available (tool-aware — see `CLAUDE.md` fallback chain)

Call the registered Jira MCP create tool with all collected fields.

After creation, if linking is needed, call the link MCP tool.

### Step 9: Post-Creation

After successful creation:
1. Display the created issue key and link: `https://redhat.atlassian.net/browse/[ISSUE_KEY]`
2. Report: Component acp, Agent Cold-Start Ready status
3. If this is an Epic, ask if the user wants to create child stories/tasks now
4. If this is a Feature, ask if the user wants to create related epics or stories
5. If this is a Risk, remind the user to set a review cadence

## Batch Execution

When batch mode is detected (markdown bullet list in `$ARGUMENTS`), skip the interactive Instructions above and follow these steps.

### Batch Step 1 — Parse

Extract from user input, per ticket:

| Field | Default | Notes |
|-------|---------|-------|
| Summary | (required) | Title of the issue |
| Issue Type | Story | Also: Bug, Task, Spike, Epic. Normalize case. |
| Priority | Normal | |
| Description | (from context) | Sub-bullets and multi-line text |
| Epic link | — | If a ticket should belong to an epic |
| Blocking | — | "X blocks Y" relationships |
| Related | — | "X related to Y" relationships |

Type prefix syntax: `[Bug] Session crashes` → type=Bug, summary="Session crashes".

Every non-Epic ticket still needs Testing Requirements and Relevant Paths in its description, even if you must infer them from the component.

### Batch Step 2 — Build Descriptions

Use the ACP description template below. Apply section guidance by issue type.

### Batch Step 3 — Confirm

Show a summary table:

```
About to create N ENGPROD tickets:

| # | Type  | Summary                        | Epic          |
|---|-------|--------------------------------|---------------|
| 1 | Epic  | Feature X                      | —             |
| 2 | Story | Implement Y                    | Feature X     |
| 3 | Bug   | Fix Z                          | —             |

Blocking: #2 blocks #3
Related: #4 related to #5

Create all? (yes/no/edit)
```

### Batch Step 4 — Create

Always set on every ticket:
- `project_key`: ENGPROD
- `components`: acp
- `labels`: team:acp
- `customfield_10464`: Future Sustainability (10606) for non-Bugs; Quality / Stability / Reliability (10608) for Bugs
- `security_level`: "Red Hat Employee" (ID: `10034`)

**Execution order** (later steps depend on earlier ones):
1. Create Epics first
2. Create remaining tickets (Stories, Bugs, Tasks, Spikes)
3. Link child tickets to epics
4. Create blocking relationships with `link_type: "Blocks"`
5. Create related links with `link_type: "Related"` (not "Relates")

Parallelize within each phase, but complete each phase before the next.

### Batch Step 5 — Report

```
Created N tickets:

| Key            | Type  | Summary                        | Epic          |
|----------------|-------|--------------------------------|---------------|
| ENGPROD-XXXXX  | Epic  | Feature X                      | —             |
| ENGPROD-XXXXX  | Story | Implement Y                    | Feature X     |

Links created:
- ENGPROD-XXXXX blocks ENGPROD-XXXXX
- ENGPROD-XXXXX → Epic ENGPROD-XXXXX
```

Browse links: `https://redhat.atlassian.net/browse/[ISSUE_KEY]`

## ACP Description Template

Use this template when building descriptions, dropping sections that do not apply:

```markdown
## Overview
[One paragraph: what needs to be done and why]

## User Story
As a [type of user], I want [goal], so that [benefit].

## Acceptance Criteria
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Technical Context
**Repo**: openshift-online/agent-control-plane
**Component**: [e.g. ambient-api-server, ambient-control-plane, ambient-ui, ambient-runner]
**Relevant Paths**:
- `components/[component]/path/to/relevant/file`

## Related Links
- Spec: [link to relevant spec in specs/]
- Related Issues: [ENGPROD-XXXX]

## Constraints
- [What NOT to do]

## Testing Requirements
- [ ] Unit tests for [X]

## Bug Details
**Steps to Reproduce**: ...
**Expected**: ...
**Actual**: ...

## Spike Deliverables
- [ ] [Output: e.g. design doc, prototype, findings]
**Time-box**: [e.g. 2 days]
```

**Section guidance by type:**
- **Epics**: Overview only
- **Stories**: Overview, User Story, Acceptance Criteria, Technical Context, Testing Requirements
- **Bugs**: Overview, Bug Details, Technical Context, Testing Requirements
- **Tasks**: Overview, Acceptance Criteria, Technical Context, Testing Requirements
- **Spikes**: Overview, Spike Deliverables (must include Time-box), Technical Context

## Field Reference

| Field | Value | Notes |
|-------|-------|-------|
| Project | ENGPROD | Engineering Productivity |
| Component | acp | Agent Control Plane (lowercase) |
| Label | `team:acp` | Set on create |
| Issue Type | Story | Default; also Bug, Task, Spike, Epic |
| Browse URL | `https://redhat.atlassian.net/browse/` | |
| Board | 348 | ENGPROD kanban board (no sprints) |

## Jira Link Types

| Relationship | `link_type` value | Notes |
|-------------|-------------------|-------|
| Blocking | `"Blocks"` | inward issue blocks outward issue |
| Related | `"Related"` | Not "Relates" — wrong name silently fails |

## Examples

### Quick Story
```
/jira-create Add session filtering by project scope
```

### Bug Report
```
/jira-create [Bug] Session list doesn't refresh after deletion

Steps:
1. Create a session
2. Delete the session via UI
3. Observe the list

Expected: Session disappears from list
Actual: Session remains until page refresh

Component: ambient-ui
Files: components/ambient-ui/src/components/session-list/
```

### Batch
```
/jira-create
- [Epic] User Onboarding Flow
- Implement SSO login page
  - Component: ambient-ui
  - Acceptance: user can log in via Keycloak
- [Task] Add onboarding docs
  - Component: docs
- [Bug] Login redirect fails on Safari
  - Steps: open Safari, click login, observe redirect loop
```

## Error Handling

- Validate date formats (YYYY-MM-DD)
- Validate time estimates use Jira format (e.g., '1h 30m', '2d')
- If the create call fails, show the error and ask the user what to fix
- Never retry creation without user confirmation
