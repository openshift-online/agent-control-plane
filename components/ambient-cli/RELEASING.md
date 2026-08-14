# Releasing acpctl

`acpctl` is released with [GoReleaser](https://goreleaser.com). Pushing a semver tag
builds cross-platform binaries, publishes a GitHub Release, and updates the Homebrew
formula in the tap — all automatically via
[`.github/workflows/acpctl-release.yml`](../../.github/workflows/acpctl-release.yml).

acpctl lives at `components/ambient-cli` in this monorepo; GoReleaser builds it via
`builds[].dir` (see `.goreleaser.yaml`).

## Cutting a release

The version comes from the git tag — nothing in the code needs bumping.

```bash
# From the repo root, on the commit you want to release:
git tag v0.1.0
git push origin v0.1.0
```

Plain `vX.Y.Z` tags trigger the release. No other component uses git semver tags
(container components release via image tags), so a `vX.Y.Z` tag is by convention the
acpctl release.

Watch the run: `gh run watch` (or the Actions tab). On success you get:

- A GitHub Release with `tar.gz` archives for darwin/linux × amd64/arm64 plus
  `checksums.txt`.
- An updated `acpctl.rb` committed to `<owner>/homebrew-tap`.

Then verify:

```bash
brew install <owner>/tap/acpctl
acpctl version   # Client: 0.1.0 (...)
```

## Required repo configuration

The workflow mints a short-lived token to push the formula, using a **GitHub App**
(`actions/create-github-app-token`) rather than a long-lived PAT, per the repo's
CI/CD security conventions. Set the following on the repo it runs in:

| Kind | Name | Value | Purpose |
| --- | --- | --- | --- |
| Secret | `HOMEBREW_TAP_APP_ID` | App ID of a GitHub App with Contents:write on `<owner>/homebrew-tap` | mints the tap-push token |
| Secret | `HOMEBREW_TAP_APP_PRIVATE_KEY` | that App's private key (PEM) | mints the tap-push token |
| Variable | `HOMEBREW_TAP_OWNER` | tap owner (optional) | selects which tap to publish to; unset → defaults to `openshift-online` |

`GITHUB_TOKEN` is provided automatically and is used only to create the Release
(the workflow grants it `contents: write`).

### Setup

1. Create a GitHub App (org- or user-owned) with **Repository permissions →
   Contents: Read and write**, and install it on `<owner>/homebrew-tap`.
2. Store its App ID and a generated private key as the two secrets above.
3. Upstream: leave `HOMEBREW_TAP_OWNER` unset (defaults to `openshift-online`).

> The `v0.1.0` fork validation used a fine-scoped **PAT** in a
> `HOMEBREW_TAP_GITHUB_TOKEN` secret with `HOMEBREW_TAP_OWNER=jeremyeder`. That is
> fine for one-off validation, but the workflow now standardizes on the App-token
> flow above; the App-token path has not yet been exercised end-to-end.

## Local dry run (no publishing)

To validate config changes without cutting a release, run from the **repo root**:

```bash
HOMEBREW_TAP_OWNER=jeremyeder \
  goreleaser release --snapshot --clean \
  --config components/ambient-cli/.goreleaser.yaml
```

Artifacts (binaries, archives, checksums, and the rendered `dist/acpctl.rb`) land in
`dist/` (gitignored). `--snapshot` skips the GitHub Release and formula push.

CI installs the **OSS GoReleaser binary directly** at a pinned version
(`go install github.com/goreleaser/goreleaser/v2@v2.17.1`) rather than the
third-party `goreleaser-action`, to minimize supply-chain surface. Use a matching
version locally (`brew install goreleaser` or `go install ...@v2.17.1`) so dry-runs
mirror CI. Keep the pin in the workflow and this doc in sync.

## Notes

- **Formula, not cask.** GoReleaser has deprecated `brews` (Homebrew *formula*
  generation) in favor of the macOS-only `homebrew_casks`. We deliberately keep the
  formula so acpctl stays installable on both macOS and Linux (Linuxbrew). This emits a
  deprecation warning; revisit before GoReleaser v3 removes `brews`.
- **Version ldflags.** `.goreleaser.yaml` injects version metadata into the Go **module
  path** `github.com/ambient-code/platform/components/ambient-cli/pkg/info` (matching
  `go.mod` and the `Makefile`). That is a linker-symbol path, not a repo URL — do not
  change it to `agent-control-plane` or version injection will silently break and
  `acpctl version` will report `dev`.
