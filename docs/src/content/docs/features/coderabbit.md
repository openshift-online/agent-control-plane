---
title: CodeRabbit Integration
description: Current CodeRabbit support in the runner and repository review workflow
---

CodeRabbit support in this repository is primarily development and runner tooling. It is not a first-class ACP REST integration in the current OpenAPI credential provider list.

## What exists

- The runner image attempts to install the CodeRabbit CLI.
- The runner can use `CODERABBIT_API_KEY` when that environment variable is available during a turn.
- The runner clears `CODERABBIT_API_KEY` after a turn along with other sensitive runtime variables.
- This repository includes `.coderabbit.yaml`, `scripts/hooks/pr-review-gate.sh`, `scripts/hooks/coderabbit-review-gate.sh`, a CodeRabbit smoke-test workflow, and triage scripts for analyzing CodeRabbit comments.

## What does not exist in the public API

The current credential OpenAPI provider enum includes `github`, `gitlab`, `jira`, `google`, `vertex`, and `kubeconfig`. It does not include `coderabbit`.

The old `/api/auth/coderabbit/...` style endpoints are not part of the current `ambient-api-server` plugin routes. If your deployment has those endpoints, they are outside the code documented here.

## Use CodeRabbit in an ACP session

If your runner image includes the CodeRabbit CLI and your deployment can provide `CODERABBIT_API_KEY`, ask the agent to run CodeRabbit as part of the task:

```text
Run CodeRabbit review against the current branch, summarize blocking findings,
fix only issues that are clearly correct, and leave uncertain comments for a human.
```

Inside the runner, the command is typically:

```bash
coderabbit review --agent --base main
```

Do not pass the API key on the command line. Provide it through runner environment wiring or a deployment-specific credential mechanism.

## Repository review gate

For contributors to this repository, the PR review gate runs mechanical checks and, when the `coderabbit` CLI is installed and authenticated, runs:

```bash
coderabbit review --agent --base main
```

The hook is `scripts/hooks/pr-review-gate.sh`. It is part of the repository development workflow, not a generic ACP user feature.

## Public repository reviews

If your organization uses the CodeRabbit GitHub App for public repositories, configure that in GitHub/CodeRabbit directly. ACP sessions can still consume the review output as ordinary repository or PR context, but ACP does not install or manage the GitHub App.
