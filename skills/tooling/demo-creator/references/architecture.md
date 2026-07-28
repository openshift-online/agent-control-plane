# Pipeline architecture

## Design goals

The pipeline favors deterministic, inspectable artifacts over live editing.
Each stage can be rerun without repeating unrelated work, while `demo run`
executes the complete path.

```text
scenario + environment
        |
        v
doctor -> resolve/lock -> provision -> capture -> compose -> validate -> verify/retain
                                      |          |           |
                                  raw media   final media   evidence
```

## Stage contracts

### Doctor

Confirm the host adapter and every executable required by the chosen sources.
Check versions, OS permissions, browser availability, extension package input,
font assets, disk space, and FFmpeg encoders. For Android, also check the SDK
tools, ADB/emulator, exact installed system image, Docker, Kind, kubectl, Make,
and FFprobe. Report actionable failures.

### Resolve and lock

Validate schema and semantic constraints, resolve relative paths, calculate
layout rectangles, and record tool/package versions in `manifest.lock.json`.
The lock must contain no environment values that could expose credentials.
Android resolution additionally binds a clean repository `HEAD` to the APK,
matching APK lock, embedded source commit/tree/schema, and digest. The authored scenario
matches the application ID; version fields and APK Analyzer identity/version
are bound by the generated lock and source-aware Doctor result.

### Provision

Create a dedicated project through the documented ACP API or `acpctl`. Use a
stable scenario-specific name and an ownership marker. Seed deterministic data
only after ownership is verified.

Android capture instead provisions an externally marker-owned AVD and one
whole, disposable Kind cluster through repository-approved Make targets using
Docker and a private kubeconfig. It never reuses an existing cluster or AVD.
The capture adapter tears both resources down in reverse order before returning;
later stages receive only portable source, artifact, and deletion evidence.

Version 1 browser capture provisions only the deterministic project envelope.
Browser scenarios must not create child ACP resources until a resource-specific
adapter declares how to seed, identify, verify, and clean each child safely.
Android may create child state only inside its whole disposable Kind cluster.

### Capture

Capture independent source streams at their intended cell dimensions where
possible. Browser scenes are full native windows. Slides become deterministic
images; terminal scenes come from VHS. Android scenes use UIAutomator/ADB and
an exact-serial `adb exec-out screenrecord --output-format=h264 ... -` stream
from the owned emulator. The first complete IDR after SPS/PPS defines
media zero for actions, deadlines, and pointers; any earlier non-IDR VCL is
invalid. After exact child close, stdout EOF, queued-write completion, and
raw-file sync, FFmpeg stream-copies exactly the authored 30 fps frame budget into
a private MP4. Validate exact packet/frame counts, keyframe-at-zero, monotonic
30 fps PTS/DTS/duration cadence, codec, dimensions, duration, exactly one video
stream, and no-audio state before publishing only the portable MP4. Raw H.264
staging is never public. Remove it after success and proven-quiescent failure;
preserve it privately if writer quiescence cannot be proved.

### Compose

Build title/end cards, captions, and pointer overlays. Compose the 1080p master
with FFmpeg, encode to H.264/YUV420P at 30 fps, and derive 720p from the master
with Lanczos scaling. Do not compose 720p independently. In a split story, a
slides or terminal segment establishes a sticky left source: pair it with the
browser capture for that segment and following browser segments until another
matching source segment replaces it.

`mobile-full` aspect-fits the complete portrait `artifacts.mobileCapture` in the
full content region using dimensions from `capture.source` and renders the one
pointer treatment from `artifacts.pointerEvents`. Those three portable fields
are the complete mobile composition input. `artifacts.androidApkLock` remains
validation provenance and Android-private paths or lifecycle state never enter
composition. This keeps the contract reusable by a future iOS adapter; iOS
capture is not implemented by this Android-focused change.

### Validate

Check artifact shape, duration, timing, frame evidence, redaction, and native UI
landmarks. Browser validation runs before its retain/cleanup decision. Android
validation runs after capture teardown and verifies the portable owned-deletion
evidence together with the retained non-secret media and provenance artifacts.

### Cleanup

Verify the exact ownership marker and retain the deterministic project envelope
for the next run. The current ACP API reserves soft-deleted project names, so a
DELETE would make the stable scenario name impossible to recreate. Refuse
ambiguous cleanup. An explicit `--keep-project` run records intentional
retention but still performs the same ownership and determinism verification.

Android cleanup is part of capture's `finally` path: reverify exact external
AVD/process and Kind/container identities, delete the owned AVD, then delete the
whole disposable cluster before capture returns. Any missing or changed
identity fails closed; composition and validation never depend on live Android
resources.

## Determinism boundary

Pin Chrome for Testing and the extension package digest. Record versions of the
browser, extension, Playwright, FFmpeg, adapter tools, Presenterm, and VHS. Avoid
wall-clock text, random IDs, transient notifications, personal browser state,
and unbounded waits in recorded content.

For Android, pin the exact installed system-image package and record portable
`capture.android.systemImage` evidence with exactly its `package` and installed
`revision`. Also record the SDK, emulator, ADB, APK Analyzer, Docker, Kind,
kubectl, Make, FFmpeg, and FFprobe
identities. The APK lock and embedded source commit/tree bind source to binary.

## Failure semantics

Fail closed when native capture, ownership, package identity, layout bounds, or
required security inspection cannot run. On a failed browser capture, stop the
recorder and delete every unclaimed `raw-browser*` and claimed `browser`
recording; retain only bounded, redacted diagnostics (such as the latest OBS log
and summary under `diagnostics/obs/`), never raw media. Always purge a browser
profile that received a bearer token, even on failure; a profile is never
required diagnostic evidence.
Android failures also keep secret-bearing UI dumps, host process arguments,
private kubeconfigs, and private marker paths out of public artifacts.
