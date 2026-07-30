# Batch Mode

Inject this as a new section immediately after **User Input** and before the main **Instructions** flow. Batch mode takes precedence over the interactive single-ticket flow.

## Recognizing Single vs Batch Mode

**Single ticket** (default): The input is a sentence, paragraph, or block of text describing one piece of work. Follow the normal interactive Instructions below.

**Batch mode**: The input contains a markdown bullet list (lines starting with `- ` or `* `). Each top-level bullet becomes a separate ticket. Sub-bullets provide context for that ticket's description. Batch mode skips the interactive interview — use sub-bullet context and reasonable defaults, then confirm the full batch before creating.

## Batch Execution

When batch mode is detected, skip Steps 1–7 of the interactive flow and follow these steps instead:

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

Use the ACP description template from the project context section. Apply section guidance by issue type.

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
