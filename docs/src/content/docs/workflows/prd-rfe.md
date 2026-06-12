---
title: "PRD / RFE Workflow"
---

Use this pattern to turn a product idea or rough requirement into a Product Requirements Document and a set of implementation-ready RFEs.

## Good inputs

Provide:

- the product goal.
- target users.
- current behavior.
- desired behavior.
- constraints and non-goals.
- examples, screenshots, or user stories.
- systems likely affected.

If the request depends on code behavior, attach the relevant repository so the agent can verify existing APIs and patterns.

## Prompt template

```text
Create a PRD and RFE breakdown for:

Problem:
<what user or business problem should be solved>

Desired outcome:
<what should be true when this ships>

Context:
<links, repos, current behavior, constraints>

Produce:
- artifacts/prd.md
- artifacts/rfes.md
- artifacts/open-questions.md

Requirements:
- separate goals from non-goals.
- define acceptance criteria.
- call out API, UI, data, auth, and migration impacts.
- do not invent existing platform features; verify against the repo when possible.
```

## Review loop

Run the session in two passes:

1. Ask for questions and assumptions first.
2. Answer the questions, then ask for the PRD/RFE artifacts.

This produces better requirements than asking for a full PRD from a vague prompt.

## Done criteria

The final artifacts should be clear enough that an engineer can:

- identify affected components.
- estimate the work.
- write or update specs.
- split implementation into reviewable changes.
- know what not to build.
