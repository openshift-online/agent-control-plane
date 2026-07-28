# Native capture adapters

## Shared browser contract

Use a pinned Chrome for Testing build with an isolated temporary profile. Load
only the verified target extension. Before launch, write that extension's ID as
the sole value in both `extensions.pinned_extensions` and
`account_values.extensions.pinned_extensions` in the private profile. Do not
fall back to pinning through the Extensions menu. Size and position one browser
window deterministically. Keep browser-window dimensions separate from the
recording canvas: the default browser is 1280x720 while the native recording
canvas remains 1920x1080. The matching 16:9 aspect ratio lets the recorder
enlarge browser chrome and extension content without cropping the real toolbar,
icon, or side-panel frame. Reject browser-window overrides whose aspect ratio
differs from the recording canvas so native UI is never stretched. Keep the
Chromium sandbox enabled and reject
`--no-sandbox`. Do not use the user's normal Chrome profile.

Always purge an isolated profile after a bearer token is configured, including
after capture failure. Profile-retention diagnostics are allowed only for a
token-free run and must never override this rule.

Start native-window recording before opening the panel. Use OS-level automation
to press the pinned extension icon. The OS-level receipt proves only that the
toolbar action was pressed; the exact matching CDP target is the authoritative
proof that the panel opened. Confirm that the captured frame includes the
toolbar, pinned icon, native side-panel frame and content, and page behind it.

Only discover the panel target after the OS-level toolbar press. Chrome may
expose extension targets before that press, so capture a baseline immediately
before pressing and accept only one exact matching non-worker target whose ID
is new afterward. Reject an unchanged preexisting match, zero new matches, or
any ambiguous target set. Attach Playwright or the bounded direct CDP driver to
that newly observed target. Never open or navigate an extension URL; a directly
navigated extension page is not proof of the native panel.

Store pointer events as newline-delimited JSON with monotonic time and normalized
coordinates:

```json
{"time_ms":1250,"x":0.742,"y":0.181,"kind":"move"}
{"time_ms":1380,"x":0.742,"y":0.181,"kind":"click","button":"left"}
```

Coordinates are relative to the captured browser-window rectangle, not the
desktop or recording canvas. Use the browser-window dimensions when projecting
CDP panel actions, then let the native recorder scale those normalized positions
to its canvas. Validate each timestamp and coordinate before merging raw events.
The explicit Lua toolbar writer and Node panel-action writer may append in a
different order from their timestamps, so finalization stable-sorts by monotonic
time and preserves raw input order for equal timestamps. The published JSONL is
therefore monotonic even when concurrent raw writes arrive out of order. Do not
record ambient physical mouse movement or clicks during an automated demo.

Validate each coordinate is within `[0, 1]`. Treat the authored browser duration
as the total native recording budget beginning when recorder readiness is
proved. Toolbar and panel actions consume that budget; hold only for the positive
remainder and fail closed when actions reach or exceed it. Anchor pointer-event
time to that same recorder-ready instant and reject events before zero or at/after
the authored duration. Composition also rejects non-finite, negative, or
regressing event time; equal timestamps are valid and retain input order. Do not
extend media or shift pointer time by treating the duration as an additional
post-action delay.

On macOS, align Node-driven
panel action timestamps to the Hammerspoon absolute-time clock. Bracket the
pointer-start invocation with Node hrtime samples and align the Hammerspoon
receipt to their midpoint. Reject half-round-trip uncertainty above 250ms. The
local `osascript` bridge was observed at 147-168ms round trip (74-84ms half
round trip); the 250ms half-round-trip bound permits pointer setup overhead but
fails closed on a stalled or remote bridge. Arm exact-PID pointer cleanup before
starting the remote action so a lost or malformed receipt cannot leave the tap
running.

## macOS adapter

- Capture the browser window through OBS ScreenCaptureKit.
- Disable ScreenCaptureKit cursor capture; composition owns the single visible,
  accessible pointer and click treatment.
- Drive browser chrome through Hammerspoon Accessibility APIs. Bind every
  pointer and extension control to the exact launched Chrome PID; never resolve
  the capture browser by application name. Force Chrome renderer accessibility
  so the exact-window preflight and toolbar controls use the same AX surface.
- Select exactly one pinned extension control by its exact verified name or ID,
  `AXPopUpButton` role, `AXPress` action, and small frame centered in the top 10%
  of the browser window. Move the pointer to that control, emit the overlay
  click event, and invoke semantic `AXPress`; do not substitute an unconstrained
  text match or raw coordinate click.
- Require Screen Recording permission for OBS and Accessibility permission for
  Hammerspoon before the run begins.
- After granting either permission, quit and reopen that application before
  capture. A capture retry starts a fresh isolated OBS process; Hammerspoon must
  be restarted separately because it is otherwise long-lived.
- Select the browser window by application identity and deterministic title,
  never by a hard-coded global screen coordinate alone.
- Use a dedicated OBS scene collection/profile or an ephemeral generated
  configuration. Do not alter or expose existing camera, microphone, or user
  scene sources.
- Launch OBS through macOS LaunchServices with the isolated allowlisted
  environment. A direct executable launch is authorized by TCC as the parent
  terminal instead of OBS. Refuse capture while another OBS instance is open,
  track the exact LaunchServices-created PID, and stop only that process.
- Refuse capture when the resolved Chrome for Testing executable already has a
  running PID. Launch and clean up only the browser process created for the run.
- Preseed `MacOSPermissionsDialogLastShown=1` in the isolated OBS `global.ini`.
  This records completion of OBS's permission-review onboarding; it does not
  grant or bypass macOS privacy permission. Without it, every fresh OBS home
  blocks unattended recording on the modal even when all permissions are
  already granted.
- Before writing the scene collection or launching OBS, use the exact launched
  Chrome PID to resolve its main or focused Accessibility window through the
  existing Hammerspoon bridge. For at most 10 seconds, require the same
  application PID, `AXWindow` role, a nonzero Core Graphics window ID, and a
  positive finite frame. Write a type `1` ScreenCaptureKit source with the exact
  Chrome bundle and that `window` ID. Do not write `display` or `display_uuid`,
  and do not fall back to type `2` application capture or whole-display capture
  when the exact-window preflight fails.
- Before launching OBS, require the launched PID to be the sole running
  Hammerspoon application with bundle ID `com.google.chrome.for.testing`, then
  start a persistent application watcher. Keep sticky evidence of any other PID
  seen with that bundle and termination of the expected PID until OBS has
  stopped. Stop and validate the watcher before claiming the recording; either
  violation fails the capture even when the other application was transient.
- Default to no audio sources.
- On failure, retain only the latest bounded, redacted OBS log and a summary in
  `diagnostics/obs/`. Never retain the token-bearing Chrome profile for
  diagnostics. `demo doctor` verifies installation but cannot verify per-app
  macOS privacy grants; the live readiness check fails before interaction when
  OBS reports denied Screen Recording permission, reports a recording failure,
  reports a ScreenCaptureKit source-initialization failure, or produces no
  isolated media. A denial or failure log takes precedence over a non-empty
  partial recording. Require FFmpeg as a capture prerequisite. After OBS stops
  and the recording is claimed, use `signalstats` to inspect at most six frames
  at two frames per second. Fail closed when none has meaningful luma spread and
  average brightness, and delete the claimed media as a uniform-black capture.
  Before stopping OBS, verify that the exact
  tracked OBS PID is still running and that the original Chrome `ChildProcess`
  still has its launched PID and a null exit code. After every failed capture,
  stop OBS and delete all unclaimed `raw-browser*` and claimed `browser` MKV,
  MP4, and MOV files before cleanup completes, including failures after the
  recording was claimed.

## Linux adapter

- Run Chrome for Testing in Xvfb at the requested canvas size.
- Preseed the verified extension as the sole pinned toolbar action before Chrome
  starts. AT-SPI must click that action directly and fail if it is absent; do
  not open the Extensions menu or use a keyboard fallback.
- Drive browser chrome with xdotool and AT-SPI where semantic accessibility is
  available.
- Capture the browser-sized region of the virtual display with FFmpeg
  `x11grab`, then scale that 16:9 input to the recording canvas.
- Disable `x11grab` mouse drawing; composition owns the single visible,
  accessible pointer and click treatment.
- Use the recorder-ready Node monotonic timestamp as the duration and pointer
  origin; Python `time.monotonic()` and Node hrtime share the Linux monotonic
  clock domain.
- Start a minimal window manager when needed for predictable placement.
- Keep the X display and profile private to the run.
- Default to no audio devices.

## Android emulator adapter

Android capture accepts only `capture.kind: android-emulator` with
`capture.cluster.kind: disposable-kind`. Run `demo doctor <scenario>` so the
check is source-aware; the legacy no-argument doctor cannot confirm a scenario's
selected system image. Doctor requires ADB, emulator, AVD Manager, SDK Manager,
APK Analyzer, Docker, Kind, kubectl, Make, FFmpeg, and FFprobe, and confirms the
exact selected system-image package is already installed. It never downloads a
different image during a run. The authored scenario keeps `systemImage` as that
package string. Successful public capture metadata records it as exactly
`{ package, revision }`, using the installed revision reported by SDK Manager;
it does not retain the installed flag, SDK location, or another private path.
Doctor proves the exact private shape
`{ package: <authored package>, revision: <revision>, installed: true }` before
the first device mutation. A revision has one to four dot-separated numeric
components of one to six digits each. Capture fails closed if any part is
missing, mismatched, false, or outside that bound.

Before the first device mutation:

1. Require Doctor's installed-image proof described above.
2. Require the canonical repository worktree to be clean and bind its exact
   `HEAD` commit and `HEAD^{tree}` before and after APK verification.
3. Resolve canonical `repo:` references for the APK and matching
   `<apk>.lock.json`; reject symlinks and files outside the worktree.
4. Require lock schema version 1 and exact lock source
   `{commit: HEAD, tree: HEAD^{tree}, path: components/mobile}`. Match the APK
   SHA-256 to the lock. Match APK Analyzer's application ID to the scenario and
   lock; match analyzed `versionName`/`versionCode` to the lock and the Analyzer
   executable identity/version to both the lock and source-aware Doctor result.
5. Require exactly one Android manifest meta-data value for each of
   `dev.ambientcode.sourceCommit`, `dev.ambientcode.sourceTree`, and
   `dev.ambientcode.apkLockSchemaVersion`; match them to `HEAD`, `HEAD^{tree}`,
   and schema version 1.

The generated Task 3 APK/lock pair remains the trust anchor. Task 4 does not
claim a private rebuild verifier until Task 3 exposes a callable verifier
contract; integrate that future verifier directly rather than guessing an
export, module path, or proof shape.

Create a generated, marker-owned Kind cluster and invoke only the repository's
`make kind-up` and `make kind-down` targets from an exact clean-commit copy in
the run-private workspace. Give both commands the generated
`KIND_CLUSTER_NAME`, `CONTAINER_ENGINE=docker`, new-cluster-only guard, explicit
run ports, and run-private home, XDG, temporary, kubeconfig, registry, and state
paths; do not use or mutate the user's current context or source checkout. The
cluster is the cleanup boundary for every child resource created by the demo.

On the first process `SIGINT` or `SIGTERM`, stop new work and let the bounded
capture `finally` path unwind cooperatively. A second signal may hard-exit. If
an action, child, or writer has not proved quiescence, do not mutate cleanup
targets: preserve the exact resources and ownership markers for manual recovery.

Prove the backend port-forward descriptor and process belong to that exact
cluster, then bind it to the owned emulator using a serial-scoped `adb reverse`.
The app receives only the derived loopback `ACP_URL`; an authored external URL
never reaches it. Remove and prove absence of the exact reverse before AVD
teardown.

Create a generated AVD from the selected installed image. Launch the emulator
with `-no-snapshot-save`, no audio or boot animation, and `-vsync-rate 30`.
Install the verified APK by inheriting the already-open exact snapshot file
descriptor as bounded standard input to `cmd package install -S`; never pass or
reopen an APK pathname in ADB or Package Manager arguments.
Android `screenrecord` has no FPS flag, so the emulator vsync setting establishes
30 fps. Bind capture to the exact owned serial and run only:

```text
adb -s <serial> exec-out screenrecord --output-format=h264 \
  --size <portrait-size> --bit-rate <bounded-rate> \
  --time-limit <1-180-second-safety-ceiling> -
```

Pipe stdout directly into an exclusively created mode-0600
`screenrecord.h264` inside the run's mode-0700 staging directory. Do not create,
pull, or remove a remote MP4. Parse the Annex-B byte stream across arbitrary
stdout chunk boundaries. Media zero is the first byte of the first complete
IDR NAL after SPS and PPS; any earlier non-IDR VCL NAL is invalid, and a
following Annex-B start code proves the IDR is complete. Use that one media
origin for the action deadline and every normalized pointer timestamp.

Stop only the exact tracked child. Before treating media as usable, require the
child `close` event, stdout EOF, completion of every queued write, and file sync
and close. Accept only a natural zero exit or the outcome of the adapter's own
graceful SIGINT. A nonzero exit, unsolicited signal, SIGTERM, or SIGKILL makes
the raw stream unpublishable even if bytes exist.

Use FFmpeg to remux the raw stream without re-encoding: declare 30 fps input,
stream-copy H.264, disable audio, and cap output at exactly
`targetFrames = ceil(authoredDurationMilliseconds * 30 / 1000)`. The integer
`screenrecord --time-limit` remains only a 1-180 second safety ceiling; it does
not define media zero or the published duration. FFprobe must prove exact packet
and decoded-frame counts, the first keyframe at zero, monotonic 30 fps
PTS/DTS/duration cadence, H.264 codec, portrait dimensions, authored duration,
one video stream, and no audio before the portable MP4 is published.

The raw H.264 file and private remux workspace never enter `raw/`, the manifest,
or another public artifact. Remove the exact owned staging directory after
success and after failures where exact child close, stdout EOF, queued-write
completion, and writer quiescence are all proven. If any proof is indeterminate,
preserve the private stage so no live writer targets an unlinked file; never
publish it, and report the preservation diagnostic.

Use UIAutomator dumps to resolve one bounded node by exact `resourceId`, `text`,
or `contentDescription`, then use ADB for tap, fill, back, wait, and expect
actions. React Native `testID` is the verbatim UIAutomator `resource-id`, so
hyphenated IDs remain bare rather than package-prefixed. Fail on zero or
ambiguous matches. Wait the fixed 900 ms after each
non-wait UI action before beginning the next; authored waits are additive.
Each setup or recorded list has at most 100 actions. Selector values contain
1-200 characters and resolution uses a fixed 5-second timeout. Wait values are
integers from 0 through 10000 ms; literal fill values contain at most 500
characters and no credential-like material. `fillFromEnvironment` is
pre-recording only; send its value through private stdin to the device driver.
Never include a
credential in host command arguments, UI dumps, pointer events, or diagnostics.

Disable Android show-touches and cursor effects. Record normalized tap/fill
centers and monotonic times as data, then render exactly one composed pointer
treatment. Publish only portable `artifacts.mobileCapture`,
`artifacts.pointerEvents`, and `capture.source` as composition inputs. Retain
`artifacts.androidApkLock` only as validation provenance; private SDK, AVD,
marker, and kubeconfig paths are not artifacts.
`capture.android.systemImage` retains only the exact selected package and
installed revision so the run remains reproducible without exposing SDK paths.

## Exact extension gate

Before launch:

1. Build the extension through its repository-approved command.
2. Locate the requested ZIP/package and calculate SHA-256.
3. Inspect its manifest and derive or verify the expected extension ID.
4. Reject an unpacked directory or package that does not match the locked
   digest and ID.
5. Record package identity in the locked manifest and validation report.

## Pointer presentation

Record intent as data, not baked pixels. Composition renders:

- a large white standard arrow with a thick black outline;
- exactly 18 frames of scale-and-press click feedback at 30 fps;
- an edge-aware reflected arrow when the hotspot is too close to the bottom or
  right edge of the content region; and
- no color-only feedback, decorative tracker shapes, or rapid flashing.

After every browser-extension `click`, `fill`, or `uploadConnection` action,
wait a deterministic 650 milliseconds before beginning the next action. This
keeps each click pulse visually distinct and gives the product UI time to
settle. Android actions use the adapter's fixed 900 ms settle instead.
Scenario-authored `wait` actions are additive to this accessibility pacing;
they do not replace it.
