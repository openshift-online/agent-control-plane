---
name: overlay-sync-skills
description: >
  Merge upstream skills with project-specific overlays from overlays/
  to produce generated files in customized/generated/. Use when overlays need
  initial generation, upstream skills drift (warned by apm install/update), or
  overlay inputs change. Triggers on: "sync overlay", "generate overlay",
  "regenerate skill", "overlay sync", "update generated skill".
---

# Overlay Sync Skills

Merge upstream skill files with project-specific overlay inputs to produce generated files.

## Scope

This skill **only** merges overlay inputs into `customized/generated/`. It does **not** deploy generated files to target directories.

**Do not run `overlay-sync.sh`.** Deploying generated files to `.claude/skills/`, `.cursor/skills/`, etc. is handled separately by APM `post-install`/`post-update` hooks or when the user explicitly asks to run the sync script.

When an overlay is up to date, stop after reporting — do not re-merge and do not deploy.

## User Input

```text
$ARGUMENTS
```

The user may provide:

- An overlay name (e.g., `jira-create`) — process only that overlay
- A custom overlay directory path (e.g., `my-project/my-overlays`) — use instead of the default
- Both (e.g., `jira-create from my-project/my-overlays`)
- Nothing — process all overlays under the default directory

## Instructions

### Step 1: Discover Overlays

Determine the overlay directory from user input. Default to `overlays/` if no directory was specified.

Scan the overlay directory for subdirectories containing `customized/config.yaml`.

If an overlay name was provided, validate it exists in the overlay directory. If it doesn't, list available overlays and stop.

### Step 2: Discover Active Targets

Run `apm targets --json` to find all active target deploy directories.

### Step 3: Process Each Overlay

For each overlay:

#### 3a: Read Overlay Inputs

Read all files in `customized/` **excluding the `generated/` subdirectory**:

- `config.yaml` — structured parameters and overrides
- All `*.md` files — prose conventions, template overrides, project context

#### 3b: Locate and Validate Upstream Files

Read `base-skill` from `config.yaml`.

**Path validation**: `base-skill` must not contain `/`, `\`, or `..`. If it does, report a config error and skip this overlay.

Look in each active target's `<deploy_dir>/skills/<base-skill>/` directory. If no active target has the directory, warn that the upstream skill is not installed and skip.

**Partial availability**: If some active targets have the directory and others don't, warn that the base skill is only installed in a subset of targets (name which ones) and note that the targets without it will only ever receive generated output via `overlay-sync.sh` — they have no upstream copy of their own to detect future drift against. Proceed with the merge using the targets that do have it.

**Cross-target validation**: Among the targets that have the directory, if there is more than one, compute SHA-256 of the upstream SKILL.md in each. If the SHAs differ, warn that targets are out of sync (likely a partial `apm install` or manual edit) and skip this overlay. Do not merge against inconsistent upstream sources.

If all targets with the directory agree (or there is only one), use the first such target's files for the merge. Read all files in that directory (`SKILL.md` and any additional `.md` files).

#### 3c: Check for Drift

If `generated/overlay.lock.yaml` exists, check whether anything has changed:

1. For each entry in the lock file's `upstream` list, compute SHA-256 of the corresponding file in the upstream skill directory (from Step 3b). Compare against the recorded `sha`. This must cover every upstream file read in 3b — `SKILL.md` and any additional `.md` files — not just `SKILL.md`.
2. For each entry in the lock file's `inputs` list, compute SHA-256 of the file at that path. Compare against the recorded `sha`.

If **all SHAs match** — every upstream file and every input — the generated files are current. Report the overlay as up to date and **skip to Step 4** (do not re-merge).

If **any SHA differs**, proceed to Step 3d. If no lock file exists (first-time generation), proceed to Step 3d.

#### 3d: Merge

Produce a merged version of each upstream file. Follow these rules in order:

1. **Precedence**: The overlay always wins. Where upstream content and overlay content conflict — a described behavior, a default value, a listed option — rewrite or replace the upstream text to match the overlay. Never keep the upstream version alongside the overlay's or leave the two contradicting each other.
2. **Structure**: Keep the upstream file's section headings, step numbering, and overall flow intact. Do not reorder, remove, or rename sections unless an overlay `.md` file explicitly says to.
3. **Config substitution**: Where the upstream file uses a generic placeholder or says to read from config (e.g., `[PROJECT]`, "read the project key from personal config"), replace with the concrete value from `config.yaml` overrides. Where an override's key instead matches something the upstream skill treats as a runtime/user-supplied input (not a literal placeholder — e.g. an example value the user would normally pass in), add it as a standing default alongside the existing behavior rather than only rewriting the example text, so the project-specific value is available even when the user supplies nothing.
4. **Prose injection**: Insert content from overlay `.md` files into the most relevant existing section of the upstream file. If the overlay content doesn't fit an existing section, add it as a new section at the end of the logical group it belongs to.
5. **Template overrides**: If an overlay `.md` file names a specific upstream file and describes replacements (e.g., "Replace the Environment section"), apply those changes to that upstream file.
6. **Self-contained output**: The merged file must stand alone. An agent reading it should never need to consult the overlay inputs. Do not add references to `config.yaml` or `customized/` in the output.
7. **No additions beyond inputs**: Do not invent project-specific content that isn't in the overlay inputs. Only merge what is provided.
8. **Preserve identity**: Do not change the upstream file's frontmatter `name` field. It must keep matching `base-skill` so `overlay-sync.sh` can locate and replace the right target directory.

#### 3e: Write Generated Files

Write all merged files to `customized/generated/`.

Write `overlay.lock.yaml`:

```yaml
base-skill: <base-skill from config.yaml>
base-skill-source: <package name from apm.lock, or "" if not found>
overlay-version: <overlay-version value from config.yaml>
generated-at: <today's date, YYYY-MM-DD>
upstream:
  - path: <relative filename read in Step 3b, e.g. SKILL.md>
    sha: <SHA-256 of that upstream file's content>
inputs:
  - path: <relative path of the overlay input file>
    sha: <SHA-256 of that file's content>
```

Include one entry under `upstream` for every upstream file read in Step 3b, not just `SKILL.md`.

#### 3f: Validate

After writing, verify:

- Every generated `.md` file has valid YAML frontmatter (if the upstream original had frontmatter)
- `overlay.lock.yaml` is valid YAML
- Every entry in the lock file's `upstream` list matches `shasum -a 256` of its corresponding upstream file

If validation fails, report the error and do not proceed to the next overlay.

### Step 4: Report

Display a summary per overlay:

```
Overlay merge complete:

  <overlay-name>
    ✓ generated/SKILL.md (merged)
    ✓ generated/overlay.lock.yaml
    upstream SHA: <sha>...

  <overlay-name>
    ✓ up to date (no changes detected)

  <overlay-name>
    ✗ skipped — upstream SKILL.md differs across targets
      .claude/skills/<name>/SKILL.md: abc123...
      .cursor/skills/<name>/SKILL.md: def456...
      Run 'apm install' to sync targets before merging.
```

Include any additional generated files in the list. Remind the user to review the diff and commit any changed overlays.
