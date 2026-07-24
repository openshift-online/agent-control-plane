# APM — Agent Package Manager

This project uses [APM](https://microsoft.github.io/apm/quickstart/) to manage
upstream agent skills, commands, and tooling. Dependencies are declared in
`apm.yml` (currently [agentic-sdlc](https://github.com/OpenShift-Fleet/agentic-sdlc)
and, when credentials are available, internal GitLab packages such as
ai-security-harness).

## What happens on `apm run install`

`apm run install` invokes `scripts/apm-install.sh`, a wrapper around `apm install`
that adds credential handling and a post-install security scan.

```
apm run install
│
├─ 1. Load credentials
│     Source repo-root `.env.local` (if present) for:
│       GITLAB_HOST      (default: gitlab.cee.redhat.com)
│       GITLAB_APM_PAT   (GitLab PAT with read_repository scope)
│
├─ 2. SkillSpector (optional, encouraged)
│     If not already on PATH, prompts in interactive shells:
│       "Install SkillSpector now? [Y/n]"
│     Default is yes. Declining (or non-interactive without APM_INSTALL_SKILLSPECTOR=1)
│     skips install and the post-install scan — APM install still continues.
│     Override: APM_INSTALL_SKILLSPECTOR=1 (auto-install) or APM_SKIP_SKILLSPECTOR=1.
│
├─ 3. Resolve dependencies (`apm install`)
│     APM runs its own pipeline for each dependency:
│       download → scan source in apm_modules/ → block or deploy → report
│     Critical hidden-Unicode findings block deploy before anything reaches
│     `.claude/`. See [Two-layer security scanning](#two-layer-security-scanning).
│     GitLab fallback (if GITLAB_APM_PAT not set):
│       temporarily strip GitLab entries from apm.yml, install the rest,
│       restore apm.yml unchanged.
│
├─ 4. Cache upstream packages → apm_modules/
│     APM fetches each dependency (clone, local copy, or marketplace
│     resolve) and stores the full package under apm_modules/.
│     This cache includes maintainer-only files (e.g. top-level scripts/)
│     that are not deployed to agents.
│
├─ 5. Deploy agent-facing content → .claude/
│     From each package, APM copies deployable primitives into the
│     harness targets declared in apm.yml (here: Claude Code):
│       .claude/skills/
│       .claude/commands/
│     apm.lock.yaml is written with pinned commits and content hashes.
│
└─ 6. Post-install SkillSpector scan (warn mode, if available)
      Our wrapper runs SkillSpector on newly deployed content:
        .claude/skills/
        .claude/commands/
      Findings are reported but do not block the install.
      This is separate from APM's built-in install gate — see below.
```

**What is not scanned on install:** `apm_modules/` (by our SkillSpector wrapper).
APM's own pre-deploy gate *does* scan source files in `apm_modules/` for hidden
Unicode before copying anything to `.claude/`. Our post-install scan targets only
what agents can reach in `.claude/skills/` and `.claude/commands/`.

For a full SkillSpector audit of everything agents can reach in this repo (deployed
skills, local skills, agents, config, CI workflows), run `apm run scan-all`.
See [Two-layer security scanning](#two-layer-security-scanning) and
[SkillSpector scanning](#skillspector-scanning) below.

## One-time setup

1. **Install APM** — follow the [APM quickstart](https://microsoft.github.io/apm/quickstart/)
2. **Configure credentials** (optional, for internal GitLab dependencies):
   ```bash
   cp .env.local.example .env.local
   # Edit .env.local and set:
   #   GITLAB_HOST=gitlab.cee.redhat.com
   #   GITLAB_APM_PAT=glpat_...   (read_repository scope)
   ```
3. **Install dependencies**:
   ```bash
   apm run install
   ```

> Without `GITLAB_APM_PAT`, install still succeeds — GitLab dependencies are
> skipped and a warning is printed. All other entries in `apm.yml` are installed
> normally.

## Daily commands

| Command | What it does |
|---|---|
| `apm run install` | Install/reinstall dependencies + post-install scan of deployed skills/commands |
| `apm run update` | Update dependencies to latest versions + regenerate lockfile + post-install scan |
| `apm audit` | Native APM audit — hidden Unicode, drift, lockfile/policy checks (see below) |
| `apm run scan-all` | Full security scan of all agent-facing content in this repo |
| `apm run scan-unmanaged` | Scan only locally authored content (skips APM-deployed `.claude/skills` and `.claude/commands`) |

Both `install` and `update` are wrapped scripts (`scripts/apm-install.sh`,
`scripts/apm-update.sh`) that handle the GitLab PAT fallback and post-install
SkillSpector scan.

## Two-layer security scanning

Agent skill security in this repo uses **two complementary scanners** at
**different points** in the pipeline. They detect different things and should
not be treated as duplicates.

### Layer 1 — APM built-in (during `apm install`)

APM runs automatically on every `apm install`, **before** files reach `.claude/`:

```
download → scan source in apm_modules/ → block or deploy → report
```

| | |
|---|---|
| **When** | Pre-deploy, inside `apm install` |
| **Scans** | Source files in `apm_modules/` before integrators copy to targets |
| **Detects** | Hidden Unicode (tag chars, bidi overrides, Glassworm-style invisible payload) |
| **Does not detect** | Plain-text prompt injection, subprocess calls, credential paths, tool abuse |
| **On critical findings** | **Blocks deploy** — nothing reaches `.claude/` |
| **Docs** | [APM Security Model — Content scanning](https://microsoft.github.io/apm/enterprise/security/) |

This is the right gate for the "file presence IS execution" threat: agent IDEs may
ingest a skill the moment it lands on disk. APM stops invisible instructions
**before** deploy.

### Layer 2 — SkillSpector (our wrapper, after `apm install`)

[SkillSpector](https://github.com/nvidia/skillspector) runs **after** APM finishes,
via `scripts/apm-install.sh` → `skill-scan.sh managed`:

| | |
|---|---|
| **When** | Post-deploy, after files are already in `.claude/skills/` and `.claude/commands/` |
| **Scans** | Deployed agent content only (not `apm_modules/`) |
| **Detects** | Subprocess usage, credential access, tool parameter abuse, skill enumeration, dependency CVEs, etc. |
| **Does not detect** | Hidden Unicode (APM's job) |
| **On findings** | **Warn only** — install already succeeded; findings are reported, not blocking |

Use `apm run scan-all` for the full agent surface (local `skills/`, `.claude/agents`,
`.github/`, etc.) — not just APM-deployed content.

### Why we use post-install SkillSpector (for now)

> In order to run SkillSpector at install time, it requires an org-level APM
> policy file (e.g. `OpenShift-Fleet/.github/apm-policy.yml` with
> `security.audit.external: [skillspector]`). Until that exists, this repo uses
> a post-install wrapper.

Plain `apm install` auto-discovers policy from the **git org remote**
(`<org>/.github/apm-policy.yml`) — not the repo-root `apm-policy.yml` in this
project. Our local file documents the desired posture but APM does not enforce
it on install today.

APM **does** support native install-time external scanning via the experimental
`external-scanners` feature — once org policy is in place:

```bash
apm experimental enable external-scanners
apm install --audit warn          # or: apm config set audit-on-install warn
```

See [APM External scanners](https://microsoft.github.io/apm/integrations/external-scanners/).

**Why the post-install wrapper persists until then:**

1. **Org policy not yet available** — without it, `apm install --audit` runs
   APM's Unicode scan only, not SkillSpector.

2. **Custom scan scope.** `skill-scan.sh` applies `.skillspector-baseline.yaml`,
   forces `--no-llm`, excludes `apm_modules/` maintainer scripts, and provides
   `scan-all` / `scan-unmanaged` for local content.

3. **Warn-only by design.** Post-install scan uses `|| true` — findings never
   block install while upstream issues are triaged.

**Once org-level policy is in place**, native `apm install --audit warn` can
replace the post-install workaround — keeping `apm run scan-all` for the
broader local agent surface.

### Native commands worth knowing

| Command | What it does |
|---|---|
| `apm audit` | Hidden Unicode scan + drift detection + lockfile checks |
| `apm audit --external skillspector` | Above plus SkillSpector via APM's SARIF integration |
| `apm install --audit warn` | Run install audit (Unicode + policy-configured externals) |
| `apm run scan-all` | Our full SkillSpector audit with baseline and custom scope |

## SkillSpector scanning

Scans use SkillSpector to detect semantic and tooling security issues in
agent-facing files.

### What gets scanned

| Scope | Directories | When |
|---|---|---|
| **Deployed APM content** | `.claude/skills/`, `.claude/commands/` | Automatically after `apm run install` / `apm run update` |
| **Full agent surface** | `.claude/` (agents, config), top-level `skills/`, `.github/` | On demand via `apm run scan-all` |
| **Local skills only** | top-level `skills/`, `.claude/` (except deployed skills/commands), `.github/` | On demand via `apm run scan-unmanaged` |

**Excluded from all scan modes:**

- `apm_modules/` — upstream package cache; includes maintainer scripts agents never see
- `components/` — application source; SkillSpector patterns match normal Go/Python/TS code and produce near-100% false positives

Imported dependency issues appear under `.claude/skills/` and `.claude/commands/`
after install — that is the surface to watch. Fix upstream (e.g. in agentic-sdlc),
then re-run `apm run install` here to pick up changes.

### Scan modes

| Mode | Scope | When to use |
|---|---|---|
| `managed` (internal) | `.claude/skills` + `.claude/commands` only | Runs automatically on install |
| `scan-all` | Full agent-facing surface (deployed + local) | Full audit |
| `scan-unmanaged` | Only locally authored content | During development |

### Reading the report

SkillSpector assigns a risk score (0–100) and lists findings by severity:
CRITICAL, HIGH, MEDIUM, LOW. Each finding includes a rule ID (e.g., `AST4`,
`TT3`), the file and line, confidence percentage, and remediation guidance.

The overall score and "DO NOT INSTALL" recommendation are calibrated for
evaluating third-party skills you haven't reviewed. For your own project, focus
on individual findings rather than the aggregate score.

### Baseline suppressions

Known false positives are suppressed via `.skillspector-baseline.yaml`. The
baseline uses glob-rule entries:

```yaml
version: 1
rules:
  - id: "AST4"
    path: ".github/scripts/*"            # Scope suppressions to specific paths
    reason: "CI helper scripts use subprocess for gcloud/gh/git"

  - id: "TM*"                           # Wildcard rule family
    path: ".github/workflows/*"
    reason: "CI workflow shell commands, not agent-controlled tool calls"
```

Every suppression requires a `reason` for audit trail. Suppressed findings don't
affect the risk score. Prefer path-scoped suppressions over global rule IDs so
imported skill issues in `.claude/skills/` remain visible.

**To add a suppression:**

1. Identify the rule ID and file pattern from the scan output
2. Add a glob-rule entry to `.skillspector-baseline.yaml`
3. Re-run the scan to verify the finding is suppressed
4. Audit what was filtered:
   ```bash
   apm run scan-all -- --show-suppressed
   ```

### Policy (`apm-policy.yml`)

Repo-root `apm-policy.yml` declares the intended posture (`on_install: warn`,
`external: [skillspector]`). It serves as a local reference until org-level
policy is available; until then, `scripts/apm-install.sh` implements the
post-install scan. See
[Why we use post-install SkillSpector (for now)](#why-we-use-post-install-skillspector-for-now).

## Troubleshooting

### Drift detected after install

`apm audit` may report drift if the lockfile is out of sync. Run:
```bash
apm run update
```
This regenerates the lockfile with all currently deployed files.

### SkillSpector not installed

**`apm run install` / `apm run update`** — optional. An interactive shell prompts
to install SkillSpector when it is missing (default **yes**). Declining does not
block the install — only the post-install scan is skipped.

**`apm run scan-all` / `apm run scan-unmanaged`** — required. The same install
prompt is offered, but declining exits without scanning (you explicitly asked to
run a scan).

| Situation | `install` / `update` | `scan-all` / `scan-unmanaged` |
|---|---|---|
| Interactive, user accepts prompt | Installs, then scans (install only) | Installs, then scans |
| Interactive, user declines | Install continues; scan skipped | Exits — scan cannot run |
| Non-interactive shell | No prompt; post-install scan skipped | Exits unless SkillSpector already installed |
| `APM_INSTALL_SKILLSPECTOR=1` | Auto-install without prompting | Auto-install without prompting |
| `APM_SKIP_SKILLSPECTOR=1` | Skip install attempt and scan | Exits — scan cannot run |

To install manually:
```bash
# Preferred
uv tool install git+https://github.com/NVIDIA/skillspector.git

# Alternative
pip install --user "skillspector @ git+https://github.com/NVIDIA/skillspector.git"

# Or via brew
brew install uv  # then use uv tool install above
```

### GitLab dependencies missing

If you see the warning about `GITLAB_APM_PAT` not being set, the install
completed successfully but skipped internal GitLab packages. To include them,
add your PAT to `.env.local` (see [One-time setup](#one-time-setup)).

## File reference

| File | Purpose |
|---|---|
| `apm.yml` | APM manifest — declares dependencies, targets, and scripts |
| `apm.lock.yaml` | Lockfile — pins exact commits and content hashes |
| `apm-policy.yml` | Intended install audit posture (not auto-enforced on install yet) |
| `.skillspector-baseline.yaml` | Suppression rules for known false positives |
| `.env.local` | Optional credentials (GitLab PAT) loaded by install wrapper |
| `scripts/apm-common.sh` | Shared logic for APM wrapper scripts |
| `scripts/apm-skillspector.sh` | Shared SkillSpector install prompt helpers |
| `scripts/apm-install.sh` | Install wrapper (GitLab fallback + post-install scan) |
| `scripts/apm-update.sh` | Update wrapper (GitLab fallback + post-install scan) |
| `scripts/skill-scan.sh` | SkillSpector scan driver (manages scan modes + baseline) |
| `.claude/skills/` | APM-installed skills (gitignored) |
| `.claude/commands/` | APM-installed commands (gitignored) |
| `apm_modules/` | APM package cache — full upstream packages, not agent-facing (gitignored) |
