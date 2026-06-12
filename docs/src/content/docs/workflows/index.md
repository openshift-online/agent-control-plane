---
title: "Workflows"
---

These workflow pages are practical patterns you can run as ACP sessions. They are not a built-in workflow catalog in the API.

ACP supports two ways to use a workflow:

- Write a good session or agent-start prompt and run it directly.
- Attach a Git-backed workflow bundle to a session with the session workflow endpoint.

Most teams should start with prompt patterns. Move to a workflow repository when the same process needs command files, reusable instructions, a rubric, or versioned team standards.

## Available patterns

- [Bugfix](bugfix/) - reproduce, diagnose, fix, test, and summarize a defect.
- [Triage](triage/) - classify and prioritize issue backlogs or incoming reports.
- [PRD / RFE](prd-rfe/) - turn a product request into clear requirements and implementation slices.
- [Custom workflows](custom/) - build a Git repository that the runner can clone into `/workspace/workflows`.

## What makes a good workflow prompt

Include:

- the target repo or files.
- the specific task.
- constraints the agent must follow.
- commands or tests to run.
- expected artifacts.
- a clear stop condition.

Avoid vague prompts such as "make this better." ACP can run long-lived agent sessions, but the quality still depends on giving the runner concrete success criteria.
