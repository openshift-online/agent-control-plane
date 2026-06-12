---
title: AgentReady
---

import { Badge } from '@astrojs/starlight/components';

<Badge text="Stable" variant="success" />

AgentReady is an external CLI for checking whether a repository is prepared for AI-assisted development. Use it before connecting important repos to ACP, or feed its report into a session as context.

## Why it helps ACP

Agents perform better when repositories contain:

- clear build and test commands.
- current documentation.
- repository instructions such as `CLAUDE.md`.
- predictable structure.
- CI configuration.
- security and contribution guidance.

AgentReady gives you a report you can use to improve those inputs.

## Run it locally

```bash
uvx agentready assess .
agentready assess /path/to/repo --format markdown --output agentready-report.md
agentready assess /path/to/repo --format json --output agentready-report.json
```

## Use the report in ACP

Attach or paste the report into a session:

```text
Read artifacts/agentready-report.md and identify the top five improvements that
would make this repository easier for ACP agents to work on. Do not change files yet.
```

Then run focused follow-up sessions for documentation, test command cleanup, or repository instruction updates.

## CI pattern

Run AgentReady in CI when you want a readiness floor:

```yaml
- name: Check agent readiness
  run: |
    uvx agentready assess . --format json --output agentready-report.json
    python - <<'PY'
    import json
    score = json.load(open("agentready-report.json"))["score"]
    if score < 75:
        raise SystemExit(f"AgentReady score {score} is below threshold")
    PY
```
