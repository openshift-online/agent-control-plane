# Demo Creator Skill Implementation Plan

## Goal

Create a reusable, deterministic skill for producing accessible ACP demos,
either from a real headed browser window or from a repository APK running in an
owned Android emulator backed by a disposable Kind cluster. For browser capture
the recorded surface must include the browser toolbar, pinned extension icon,
native side panel, and page content; browser capture runs on macOS (OBS and
Hammerspoon) or Linux (Xvfb and xdotool/AT-SPI). Android capture additionally
requires the Android SDK command-line tools, emulator, ADB, Docker, Kind,
kubectl, and Make. The locally runnable production toolchain must be
free/open-source except for Chrome for Testing: it is the sole free-to-use,
non-open-source binary exception because native Chrome toolbar and extension
behavior require it. The pipeline must not require a paid license, subscription,
or hosted service.

## Output Contract

- Produce a 1920x1080, 30 fps H.264/YUV420P master with fast-start metadata.
- Produce a Lanczos-downscaled 1280x720 derivative.
- Reserve a bottom caption band: 144 px at 1080p and 96 px at 720p.
- Emit raw captures, a locked manifest, normalized pointer events, VTT/SRT
  captions, a transcript, contact sheet, validation report, and both final MP4s.
- Default to a three-second title, restrained 300 ms transitions, a
  three-second end card, silent playback, and a 60-90 second duration.

## Architecture

1. A scenario manifest declares inputs, layout, captions, browser actions, ACP
   target, and production settings.
2. An exact browser-extension package gate builds and verifies the ZIP before
   capture.
3. Platform adapters record a real Chrome for Testing window with an isolated
   profile and only the target extension enabled:
   - macOS uses Hammerspoon Accessibility control and OBS ScreenCaptureKit.
   - Linux uses Xvfb, xdotool/AT-SPI, and FFmpeg x11grab.
4. Playwright attaches to the native side-panel target. Direct extension-page
   simulation is not an acceptable substitute.
5. Presenterm renders slide inputs; VHS renders terminal inputs; deterministic
   HTML renders branded title and end cards.
6. FFmpeg composes layouts, captions, pointer emphasis, transitions,
   derivatives, and validation artifacts.

## Layout and Accessibility Contract

- `browser-full`: full content region.
- `slides-extension`: slides left, extension right.
- `terminal-extension`: terminal left, extension right.
- `split`: configurable 30-70 percent split.
- The extension-right default is 630 px plus a 24 px gap at 1080p, and 420 px
  plus a 16 px gap at 720p.
- Captions use white Red Hat Text on black, up to two short lines, 42-45 px at
  1080p and 28-30 px at 720p.
- The pointer is a large white standard arrow with a black outline. Clicks
  emphasize the press with a scale-and-press pulse for exactly 18 frames,
  clamped only when the video ends sooner, using shape and motion rather than
  color. No click ring is added.
- The default visual treatment uses `#292929`, coral `#F56E6E`, Red Hat red
  `#EE0000`, white text, a subtle dot grid, Red Hat Display/Text/Mono, and the
  ACP robot mark.

## Safety and Repeatability

- ACP URL and bearer token are environment-only values. The scenario declares
  its non-secret project name, and `ACP_PROJECT` must repeat that exact value in
  the environment so the runner can reject a mismatched target.
- Version 1 manages one deterministic project envelope with a stable
  scenario-derived name and exact ownership markers. It does not manage child
  ACP resources; scenarios must not create them until a declared child-resource
  cleanup adapter exists.
- ACP soft-deletes projects while reserving their name-backed IDs. Default
  cleanup therefore verifies exact ownership and deterministic state, then
  retains the envelope for the next run instead of issuing DELETE.
- Cleanup after a successful seed fails if the project is missing, unowned, or
  no longer deterministic.
- Secrets are forbidden in scenarios, captions, tapes, logs, screenshots,
  contact sheets, media metadata, and reports.
- Temporary browser profiles are private. Any profile that received a bearer
  token is always purged, including after failure.
- `--keep-project` records explicit retention, but it does not bypass cleanup
  ownership or determinism checks.

## Public Commands

```text
demo doctor
demo init <scenario>
demo capture <scenario>
demo compose <scenario>
demo validate <scenario>
demo run <scenario>
```

## Verification Gates

- Schema and semantic validation, including resolution and layout math.
- Caption size, bounds, contrast, and timing validation.
- Pointer mapping, secret redaction, and project ownership tests.
- Exact extension package verification.
- Native-browser smoke coverage on macOS and Linux, including toolbar, pinned
  icon, and native panel.
- FFprobe format, resolution, frame-rate, pixel-format, and duration checks.
- Representative visual frames and contact-sheet review.
- Sampled OCR as defense in depth plus mandatory human review before public
  release; OCR success is not proof of absence.
- Skill evals for full-browser, slides-plus-extension, and terminal-plus-
  extension scenarios.
- Dependency and asset provenance validation.

## Execution Order

1. Implement the skill contract, manifest schema, CLI, assets, and examples.
2. Implement the extension gate, platform capture adapters, and deterministic
   renderers.
3. Implement FFmpeg composition and validation.
4. Run automated tests, synthetic media integration, skill evals, native smoke
   tests where host permissions permit, and visual review.
5. Resolve review findings and commit the feature branch without pushing.
