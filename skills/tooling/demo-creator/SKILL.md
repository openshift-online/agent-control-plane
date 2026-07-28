---
name: demo-creator
description: >
  Use when a user asks to record, script, compose, validate, or reproduce a
  deterministic product demo using the ACP browser extension, native Chrome
  side panel, slides, terminal footage, or an Android emulator and disposable
  Kind cluster.
compatibility: >
  macOS with OBS and Hammerspoon, or Linux with Xvfb and xdotool/AT-SPI;
  FFmpeg, Tesseract OCR, Node.js, Chrome for Testing, Playwright, Presenterm,
  and VHS. Android capture additionally requires the Android SDK command-line
  tools, emulator, an installed system image, ADB, Docker, Kind, kubectl, and Make.
---

# Demo Creator

Create silent-first product demos whose captions, pointer feedback, and visible
application state communicate the complete story without narration. Capture the
real browser chrome and native extension panel, or a repository APK in an owned
Android emulator; never substitute authored or simulated footage.

## User input

```text
$ARGUMENTS
```

Treat the first positional argument as a scenario path. Recognize `doctor`,
`init`, `capture`, `compose`, `validate`, and `run` as workflow commands.

## Workflow

1. Read `references/scenario-format.md` and the selected scenario.
2. Run `demo doctor <scenario>` for a source-aware prerequisite check. The
   legacy no-argument `demo doctor` remains available as a general host check,
   but it cannot prove an Android scenario's selected system image. Resolve
   missing prerequisites before capture; do not silently downgrade native UI.
3. For browser capture, build and verify the exact extension package. For
   Android capture, require a clean source worktree and verify the repository
   APK, matching lock, embedded source commit and tree, lock schema, digest,
   and application identity.
   The Android example requires Task 3 to generate the canonical
   `components/mobile/dist/ambient-mobile.apk` and adjacent
   `ambient-mobile.apk.lock.json` pair. Those files are intentionally absent
   from this isolated Task 4 branch; do not replace them with fixtures.
   Until Task 3 exposes a callable canonical rebuild verifier, its generated
   lock `{source: {commit, tree, path}}`, embedded APK metadata, and digest are
   the trust anchor; do not invent a substitute verifier interface.
4. Create only the owned lifecycle for the selected adapter: a marker-owned ACP
   project for browser capture, or an externally marker-owned AVD plus a whole
   disposable Kind cluster for Android capture. Refuse ambiguous ownership.
5. Capture each source using the platform adapter in `references/capture.md`.
   Android capture verifies and deletes its exact owned AVD and Kind cluster in
   its capture `finally` path before returning portable lifecycle evidence.
6. Compose the 1080p master first, then derive 720p with Lanczos scaling.
7. Run `demo validate`; inspect the contact sheet and representative frames in
   addition to machine checks.
8. Verify cleanup ownership. Browser capture retains the deterministic project
   envelope because ACP reserves soft-deleted names. For Android, consume the
   owned-deletion evidence returned by capture; the adapter has already deleted
   its exact AVD and disposable cluster and never targets an existing resource.

Use the public CLI:

```shell
demo doctor
demo doctor <scenario>
demo init <scenario>
demo capture <scenario>
demo compose <scenario>
demo validate <scenario>
demo run <scenario>
```

If the executable is not installed globally, invoke the repository entry point
documented by `demo doctor`.

## Non-negotiable capture contract

For browser-extension scenes, show one headed Chrome for Testing window with:

- the toolbar/address region;
- the pinned target extension icon and tray area;
- the actual native side-panel frame and content;
- the page behind the panel.

Use an isolated profile and pin only the target extension. Open the panel by
clicking the native icon with OS-level automation. After opening it, attach
Playwright to the native side-panel target; fall back to a matching CDP target,
then Accessibility-driven controls. If none works, fail with evidence. Directly
opening the extension page is not a valid fallback for native-panel capture.

Record normalized pointer coordinates and monotonic timestamps. Render one
large white standard arrow with a thick black outline and an exactly 18-frame
scale-and-press pulse, clamped only when the video ends sooner. Never add a
click ring, Android show-touches halo, or recorder cursor.

For Android scenes, require `capture.kind: android-emulator`,
`capture.cluster.kind: disposable-kind`, and `layout.preset: mobile-full`. The
story contains at least one `mobile` scene and otherwise only `title` and `end`;
browser, slides, and terminal sources require their own capture/layout contract.
The
runtime owns the repository APK gate, external AVD and Kind markers, emulator,
ADB screen recording, UIAutomator/ADB actions, pointer-event capture, and
whole-cluster cleanup. A `mobile` story item never authors `source`; composition
accepts only `artifacts.mobileCapture`, `artifacts.pointerEvents`, and
`capture.source`. `artifacts.androidApkLock` is provenance evidence for
validation, not media input.

Record Android media from the exact owned serial with
`adb -s <serial> exec-out screenrecord --output-format=h264 ... -`. Stream stdout
exclusively into a mode-0600 raw H.264 file inside the owned mode-0700 staging
directory. Define media zero at the first byte of the first complete IDR after
SPS and PPS, reject any earlier non-IDR VCL, and preserve the origin even when
Annex-B start codes cross stdout chunks; action deadlines and pointer timestamps
use that same origin. Publication requires the exact child to close, stdout to
reach EOF, every queued write to complete, and the file to sync. A nonzero exit
or unsolicited/forced signal makes the recording unpublishable.

Remux without re-encoding through FFmpeg at 30 fps, using stream copy and exactly
`ceil(authoredDurationMilliseconds * 30 / 1000)` frames. Publish only after
exact packet and frame counts, keyframe-at-zero, monotonic 30 fps
PTS/DTS/duration cadence, H.264 codec, portrait-dimension, duration,
exactly-one-video-stream, and no-audio validation succeeds. The private raw
stream is never an artifact. Remove it
after success and proven-quiescent failure; preserve it privately when child
close, stdout EOF, or writer quiescence cannot be proved.

Keep Android setup actions separate from recorded actions. Only setup may use
`fillFromEnvironment`, and only for `ACP_URL`, `ACP_PROJECT`, or
`ACP_BEARER_TOKEN`. Author exactly
one `ACP_URL` setup target; the adapter supplies its owned ADB-reversed loopback
origin rather than accepting a caller URL. Advanced bearer setup uses
`ACP_BEARER_TOKEN`; OIDC stays in the app's system-browser PKCE flow and never
collects a username or password. A non-secret `ACP_PROJECT` target must
correspond to a real client control and repeat `acp.project`; no credential
value may appear in the scenario, a host process argument, logs, or artifacts.

## Composition contract

Produce a 1920x1080, 30 fps H.264/YUV420P master with fast-start metadata. The
content area is 1920x936 and the bottom caption band is 1920x144. Derive a
1280x720 version whose content and caption regions are 1280x624 and 1280x96.

Support these layouts:

- `browser-full`
- `slides-extension`
- `terminal-extension`
- `split`, constrained to a 30–70% ratio
- `mobile-full`, which aspect-fits the complete portrait capture inside the
  entire content region without stretching or cropping

For extension-right layouts, default to a 630 px right cell and 24 px gap at
1080p, or 420 px and 16 px at 720p. Preserve source aspect ratios with
scale/pad/crop; never stretch UI footage.

Use FFmpeg for scale, pad, crop, overlay, concat, restrained 300 ms crossfades,
and ASS overlays. Use deterministic HTML stills for the 3-second title and end
cards. Default to silent output and the shortest runtime that tells the complete
story. End each content segment 2–4 seconds after its last meaningful action or
caption unless the scenario explicitly needs a longer hold.

Render captions once at exactly 44 px in the 1080p master. The required Lanczos
scale of that master produces the nominal 29 px caption in the 720p derivative;
do not render the derivative independently. Mobile captions use no more than two
lines, remain visible for at least 2.5 seconds, and contain no more than 3 words
per second. Disable Android show-touches and recorder cursor effects; render one
composed pointer treatment from normalized tap events.

Read `references/visual-system.md` before authoring cards, captions, or slides.
Read `references/validation.md` before accepting an output.

## Content sources

- Use Presenterm Markdown as the default slide source. Export self-contained
  HTML at fixed dimensions and rasterize each slide deterministically.
- Use VHS `.tape` files as the default terminal source. Keep typed commands and
  output synthetic and stable.
- In a split story, a slides or terminal segment establishes the left source.
  Keep pairing it with later browser segments until another matching source
  segment replaces it.
- Use Playwright for web and extension state, not for clicking native browser
  chrome.
- For Android, use an already-installed, explicitly selected system image and
  retain its exact package plus installed revision as portable evidence. Use
  the repository-approved `make kind-up`/`make kind-down` targets with Docker
  and a run-private kubeconfig. Do not author mobile source media.

## Security boundary

Pass ACP credentials only through the adapter's approved environment variables.
Browser scenarios declare the non-secret project and require `ACP_PROJECT` to
repeat that exact value in the environment. An Android scenario does so only
when the real client exposes a project control; projectless Artoo onboarding is
valid. This intentional non-secret duplication is the only environment-value
duplication in a scenario. Never
serialize credentials into scenarios, captions, tapes, logs, screenshots,
contact sheets, metadata, process arguments, or validation reports. Keep
temporary profiles and Android setup input private and purge them after failure.
Treat sampled OCR as defense in depth and require a human review before public
release.

Read `references/security-and-ownership.md` before provisioning or cleanup.

The v1 browser lifecycle owns only the deterministic ACP project envelope.
Browser scenarios must not create project-scoped child resources such as agents,
sessions, credentials, providers, or settings until a declared adapter can
identify, verify, and clean them. Android may create child state only inside its
whole disposable Kind cluster, whose deletion is the cleanup boundary.

## Outputs

Retain enough evidence to reproduce and audit each run:

```text
raw/                    source captures
manifest.lock.json      resolved scenario and tool versions
pointer-events.jsonl    normalized pointer events
raw/android-apk-lock.json  copied APK lock evidence for Android runs
captions.vtt            accessible captions
captions.srt            editor-compatible captions
transcript.txt          readable demo transcript
contact-sheet.png       representative visual frames
validation-report.json  machine-readable gates
demo-1080p.mp4          master
demo-720p.mp4           derivative
```

For Android, `raw/` contains only the validated portable MP4 and retained public
evidence. It never contains the private `screenrecord.h264` staging stream.

## Detailed references

- `references/architecture.md`: pipeline stages and artifact boundaries
- `references/scenario-format.md`: declarative scenario contract
- `references/capture.md`: browser and Android native capture adapters
- `references/visual-system.md`: ACP visual and accessibility rules
- `references/security-and-ownership.md`: credentials and ACP lifecycle guards
- `references/validation.md`: required automated and visual gates
- `references/licensing.md`: approved toolchain and reviewed binary exceptions
