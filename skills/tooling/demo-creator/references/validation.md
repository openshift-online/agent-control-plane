# Validation gates

An encoding command returning zero is not sufficient. Run automated checks and
inspect the user-facing evidence.

## Scenario and layout

- Schema and semantic validation pass.
- Every calculated rectangle is within the content canvas.
- Extension-right widths/gaps match the selected profile unless explicitly and
  validly overridden.
- Split ratios stay between 30% and 70%.
- Captions fit the band, use no more than two lines, and meet contrast targets.
- Mobile scenarios use `mobile-full`, have no authored mobile source, and keep
  every caption visible for at least 2.5 seconds at no more than 3 words per
  second.

## Capture

- The extension package digest and ID match the locked manifest.
- macOS and Linux smoke fixtures prove the toolbar, pinned icon, native panel,
  and page behind it are visible.
- Pointer coordinates are normalized and timestamps are monotonic.
- Click feedback lasts exactly 18 frames, unless the video ends first.
- Android capture records generic `artifacts.mobileCapture`,
  `artifacts.pointerEvents`, `artifacts.androidApkLock`, and `capture.source`.
- Composition consumes `artifacts.mobileCapture`, `artifacts.pointerEvents`, and
  `capture.source`; `artifacts.androidApkLock` is validation provenance only.
- Android APK evidence binds a clean source commit and tree, exact lock source
  path, embedded `dev.ambientcode.sourceCommit`, `dev.ambientcode.sourceTree`,
  lock-schema metadata, lock digest, and APK digest. Application ID
  matches the scenario and lock; version fields and APK Analyzer identity/version
  match the generated lock and source-aware Doctor result.
- Android manifest and validation evidence retain the exact installed
  system-image `{ package, revision }`; the package must match the authored
  scenario and neither field may contain SDK or other host-private paths.
- Android source evidence proves positive portrait dimensions, exactly 30 fps,
  no audio, bounded duration, non-empty portable landmarks derived from the
  completed bounded action sequence, exact installed application/version
  identity, successful raw-media validation, and UIAutomator/ADB action results.
- Android recording evidence proves exact-serial `adb exec-out` H.264 streaming,
  split-safe SPS/PPS plus complete-IDR readiness, one media-zero origin for
  actions/pointers/deadline, exact child close, stdout EOF, queued-write
  completion, and raw-file sync. A nonzero exit or unsolicited/forced signal is
  unpublishable.
- The private lossless remux uses 30 fps stream copy and exactly
  `ceil(authoredDurationMilliseconds * 30 / 1000)` frames. FFprobe proves
  matching packet and frame counts, first keyframe PTS/DTS zero, monotonic 1/30
  packet cadence, H.264 codec, portrait dimensions, authored duration, one video
  stream, and no audio before portable MP4 publication.
- Android lifecycle evidence proves exact external marker/live identity checks
  and successful owned AVD plus whole-cluster cleanup inside capture before it
  returned. Any ambiguity is a fail.

## Media

Use `ffprobe` to verify:

- 1920x1080 and 1280x720 outputs;
- 30 fps video;
- H.264 codec;
- YUV420P pixel format;
- expected duration within the defined tolerance;
- no audio stream for silent scenarios;
- fast-start-compatible MP4 output.

Android's `screenrecord --time-limit` is only a bounded 1-180 second process
safety ceiling. It is not accepted as duration or timing evidence.

Expected duration and caption timestamps use the final crossfade-overlapped
timeline, not the unmodified sum of story segment durations.

Generate a contact sheet that samples the title, each scene, transitions, and
end card. Inspect representative frames at both resolutions for clipping,
stretching, unreadable captions, stale UI, cursor alignment, native side-panel
presence, and accidental personal information.

For `mobile-full`, inspect that the complete portrait screen is visible and
aspect-fit in the full content region at both resolutions. Confirm there is one
composed pointer treatment and no Android show-touches/cursor halo. Verify
captions render once at exactly 44 px in the master and appear at the nominal
29 px size produced by the pure two-thirds Lanczos derivative; reject an
independently rendered 720p caption track.

Visual secret inspection is mandatory and local. `demo compose` and
`demo validate` use Tesseract OCR on every image and on up to 24 evenly spaced
frames from every video. FFmpeg performs frame extraction in a mode-0700
temporary directory that is removed immediately. Missing OCR/frame tools,
failed extraction, an empty sample, or failed OCR is a required failure. Passing
sampled OCR means no configured pattern appeared in those samples; it is
defense in depth, not proof that the video contains no secret or personal data.
Run `demo doctor` to verify Tesseract before capture.

Before public release, a human must watch the final video and inspect the
contact sheet for credentials, personal data, notifications, unrelated browser
state, and stale UI. Automated validation cannot waive this release gate.

## Security and lifecycle

- Scan all text, media metadata, OCR text from images, and sampled video frames
  for known environment values and common secret patterns.
- For Android output scanning, transiently select only caller-secret values
  named by `setupActions` (currently `ACP_BEARER_TOKEN`) and scan their raw,
  JSON-escaped, URI-encoded, base64, and base64url forms. A missing selected
  secret fails closed. The adapter-generated `ACP_URL` and non-secret
  `ACP_PROJECT` remain covered by setup UI audit and value-free diagnostics.
  Findings record only a static redaction, never the configured value or its
  encoding.
- Confirm reports and media metadata contain no bearer token or auth header.
- For browser runs, and Android runs that author `ACP_PROJECT`, verify cleanup
  accepts only a marker-owned ACP project and retains its stable deterministic
  envelope for reuse.
- Verify browser scenarios do not create child ACP resources unless every child
  type has a declared ownership and cleanup adapter. Android child state must
  remain inside the verified whole disposable Kind cleanup boundary.
- Verify every token-bearing browser profile is gone, including after a failed
  capture.
- Verify Android environment input never appears in host process arguments, UI
  dumps, pointer events, copied lock evidence, media, or reports.
- Verify private `screenrecord.h264` staging is absent after success and after a
  failure whose exact child close, stdout EOF, queued-write completion, and
  writer quiescence are proven. When any of those facts is indeterminate,
  preserve the private unpublished stage so no live writer targets an unlinked
  file. It must never appear in retained public artifacts, manifests, reports,
  or diagnostics.

## Report

Write `validation-report.json` with each gate's stable ID, pass/fail status,
evidence path or measured value, tool versions, and any manual-review note.
Redact diagnostics before serialization. A required `fail` prevents a successful
`demo run` exit. Automated success does not assert that the human public-release
review has happened.

The report stores automated results in `automatedGates`. Android reports retain
only portable `capture.source`, `capture.android`, and owned-deletion
`capture.lifecycle` evidence; AVD, cluster, marker, process, and host-path
identities are excluded. `manualReview` records the required final-video and
contact-sheet gates as `pending` for downstream human review, and
`releaseReady` therefore remains false even when every automated gate passes.
The final report object is itself scanned against generic patterns and every
selected Android setup-value representation before it is serialized. A finding
fails the security gate and replaces variable evidence and artifact names with
safe redacted defaults rather than writing the matched value.

A complete Android run also retains `raw/`, `manifest.lock.json`,
`pointer-events.jsonl`, `raw/android-apk-lock.json`, `captions.vtt`,
`captions.srt`, `transcript.txt`, `contact-sheet.png`, `demo-1080p.mp4`, and
`demo-720p.mp4`. Missing sidecars or review evidence prevents release even when
the encoder succeeds.
