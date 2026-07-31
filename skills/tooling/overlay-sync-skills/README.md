# Overlay Sync Skills

Customize upstream APM skills with project-specific configuration without forking them.

This directory contains two tools that work together:

- **`/overlay-sync-skills`** (SKILL.md) — an agent skill that merges upstream skill files with your overlay inputs to produce generated output. Runs inside an agent session (requires LLM).
- **`overlay-sync.sh`** — a bash script that copies generated files into active target deploy directories. Runs automatically as an APM `post-install`/`post-update` hook. No LLM needed.

## Quick Start

### 1. Create an overlay

Create a directory under `overlays/` named after the upstream skill you want to customize:

```
overlays/<skill-name>/
  customized/
    config.yaml           # required — structured parameters
    project-context.md    # optional — prose conventions, context
    *.md                  # optional — additional overlay inputs
```

**`config.yaml`** must include at minimum:

```yaml
overlay-version: "1"
base-skill: <upstream-skill-name>
project: <your-project-name>
overrides:
  # key-value pairs that replace placeholders in the upstream skill
```

Example (`overlays/jira-create/customized/config.yaml`):

```yaml
overlay-version: "1"
base-skill: jira-create
project: agent-control-plane
overrides:
  jira_project: "ENGPROD"
  jira_component: "acp"
  default_priority: "Normal"
```

**`*.md` files** contain free-form prose that gets injected into the merged skill — project conventions, template overrides, component lists, anything the agent should know when running the skill.

### 2. Generate the merged output

In your agent session, run:

```
/overlay-sync-skills jira-create
```

Or process all overlays at once:

```
/overlay-sync-skills
```

The skill reads the upstream SKILL.md + your overlay inputs, merges them, and writes the result to `customized/generated/`:

```
overlays/jira-create/
  customized/
    config.yaml
    project-context.md
    generated/              # created by /overlay-sync-skills
      SKILL.md              # merged skill — commit this
      overlay.lock.yaml     # provenance record — commit this
```

Review the diff and commit the generated files.

### 3. Sync to targets

The generated files need to land in `.claude/skills/`, `.cursor/skills/`, etc. This happens automatically:

- **On `apm install` / `apm update`**: the `overlay-sync.sh` script runs as a post-install/post-update hook (wired in `apm.yml`) and copies generated files into every active target's deploy directory.
- **Standalone**: run `./skills/tooling/overlay-sync-skills/overlay-sync.sh` manually at any time.

The sync script replaces the upstream skill files with your generated versions in each target directory.

> **Note:** APM captures `post-install`/`post-update` hook output only to `~/.apm/logs/scripts.log` — it does not print to the console, even with `-v`. If you're relying on the hook, either check that log for drift/skip warnings after `apm install`/`apm update`, or run `./skills/tooling/overlay-sync-skills/overlay-sync.sh --hook post-install` (or `post-update`) manually to see the output directly.

## Custom overlay directory

Both tools default to `overlays/` but accept a custom path:

```
# Agent skill — natural language
/overlay-sync-skills jira-create from my-project/overlays

# Bash script — flag
./skills/tooling/overlay-sync-skills/overlay-sync.sh --overlay-dir my-project/overlays
```

## Drift warnings

The `overlay.lock.yaml` file tracks the SHA-256 of the upstream skill and every overlay input at generation time. When something changes, you'll see warnings:

**Upstream drift** — `apm update` pulled a newer version of the skill:

```
  jira-create
    ⚠ upstream SKILL.md differs — overlay may be stale, run /overlay-sync-skills to regenerate
      lock:     a9056767b757...
      upstream: def456abc123...
    ✓ .claude/skills/jira-create/ (1 file(s) synced)
```

The stale generated files are still copied (stale is better than missing). Run `/overlay-sync-skills` to regenerate from the new upstream.

**Input drift** — you edited `config.yaml` or a `*.md` file but didn't regenerate:

The `/overlay-sync-skills` skill checks input SHAs before merging. If nothing changed, it skips the overlay. If inputs changed, it regenerates.

## What gets synced

- All files in `customized/generated/` **except** `overlay.lock.yaml` are copied to each target
- The lock file stays in `generated/` as provenance metadata — agents don't need it
- If the upstream skill has additional files (e.g., `template.md`), the merge produces generated versions of those too

## Multi-file overlays

Some skills reference additional `.md` files beyond `SKILL.md`. To customize those, add a `template-overrides.md` (or similar) to your `customized/` directory describing what to change:

```
overlays/bug-specialist/
  customized/
    config.yaml
    project-context.md
    template-overrides.md    # instructions for modifying template.md
    generated/
      SKILL.md               # merged
      template.md            # also merged
      overlay.lock.yaml
```

The `/overlay-sync-skills` skill reads all `*.md` files in `customized/` and applies them to the appropriate upstream files.

## File reference

| File | Purpose |
|---|---|
| `SKILL.md` | Agent skill — LLM merge logic, runs in agent session |
| `overlay-sync.sh` | Bash script — copies generated files to targets, drift detection |
| `apm.yml` (repo root) | Hooks: `post-install` and `post-update` point to `overlay-sync.sh` |
| `overlays/` | Default overlay directory |
| `skill-overlay-architecture.md` (repo root) | Architecture doc — design rationale and spec alignment |
