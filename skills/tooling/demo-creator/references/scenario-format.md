# Scenario format

Use YAML for human-authored scenarios. Treat it as declarative data: no inline
shell interpolation, executable expressions, or embedded credentials.

## Shape

```yaml
version: 1
id: connection-file-flow
title: Connect ACP in one step
description: Load a connection file and open a session.
fps: 30
canvas:
  master: 1080p
  derivative: 720p
layout:
  preset: browser-full
story:
  - type: title
    durationSeconds: 3
  - type: browser
    source: raw/browser.mp4
    durationSeconds: 69
    note: Open the pinned icon and import the synthetic connection.
  - type: end
    durationSeconds: 3
captions:
  - startSeconds: 3
    endSeconds: 7
    text: Open ACP from the pinned extension icon.
  - startSeconds: 8
    endSeconds: 13
    text: The connection file configures the extension in one step.
acp:
  project: demo-connection-file-flow
extension:
  expectedId: bjlckanpiblmfadkmknbbpeenckfdgpi
  actions:
    - action: wait
      ms: 5000
    - action: uploadConnection
      selector: "#importKindConnections"
    - action: expect
      selector: "#kindImportStatus"
      text: selected
production:
  title: Connect ACP in one step
  subtitle: Configure the native extension from one connection file.
  endTitle: Connection complete
  endText: The workflow is ready to repeat.
  transitionMilliseconds: 300
  silent: true
```

Browser capture accepts `ACP_URL`, `ACP_PROJECT`, and `ACP_BEARER_TOKEN` from the
environment. Android `fillFromEnvironment` setup actions use only those three
field names, and the adapter derives `ACP_URL` from its owned Kind port-forward
and serial-bound ADB reverse rather than accepting the caller's URL.
`ACP_PROJECT`, when the real client control exists, must exactly equal the
scenario's `acp.project`; the Artoo onboarding example does not invent that
control. Advanced bearer setup uses `ACP_BEARER_TOKEN`. OIDC remains the app's
system-browser PKCE flow, so the capture skill never collects an OIDC or
identity-provider username or password. The CLI refuses to provision, mutate,
capture, or clean up when these constraints fail. Scenario files must not
contain credential values. See
`examples/android-onboarding/scenario.yaml` for the complete Android shape.

## Semantic rules

- `version` is `1`.
- `id` is a stable lowercase slug between 3 and 58 characters.
- `canvas.master` is `1080p` and `canvas.derivative` is `720p`.
- `fps` is `30` unless an explicit future profile adds another validated value.
- `layout.preset` is one of `browser-full`, `slides-extension`,
  `terminal-extension`, `split`, or `mobile-full`.
- `layout.leftPercent`, when set for `split`, is an integer from 30 to 70.
- `story` preserves author order. Each item has a supported `type`, positive
  `durationSeconds`, and optional source/note.
- A `slides` or `terminal` segment establishes the left source for its matching
  split layout. That source remains paired with the browser capture during that
  segment and later `browser` segments until another matching source replaces
  it. Put the source segment before any browser segment that should reuse it.
- Browser scenarios require `acp.project` exactly equal to
  `demo-<scenario-id>` so the CLI can enforce stable, scenario-specific
  ownership. Android requires the same envelope only when setup authors a real
  `ACP_PROJECT` control; projectless Android onboarding is valid.
- Scenario files cannot skip ACP cleanup verification. `--keep-project` records
  explicit retention but still verifies the exact ownership markers and
  deterministic project fields. The project envelope remains reusable because
  ACP reserves a soft-deleted project's stable name.
- Version 1 browser scenarios must not create child ACP resources. Agents,
  sessions, credentials, providers, settings, and other project-scoped records
  require a declared child-resource cleanup adapter before they can become
  browser actions. Android may create child state only inside its whole
  disposable Kind cluster, whose deletion is the cleanup boundary.
- A mobile story item uses `type: mobile` and requires `layout.preset: mobile-full`,
  `capture.kind: android-emulator`, and `capture.cluster.kind: disposable-kind`.
  It has no authored `story[].source`; the runtime supplies the verified source.
- An Android/mobile story contains at least one `mobile` item and otherwise only
  `title` and `end` items. Browser, slides, and terminal items are invalid
  because `mobile-full` has no deterministic source or layout for them.
- `capture.android` requires a bounded `expectedApplicationId`, a
  `launchActivity` whose package matches it, canonical `repo:` paths for an APK
  and its exact `<apk>.lock.json`, an explicitly installed stable-style Android
  SDK `systemImage`, and at least one recorded action. The scenario matches the
  APK application ID only; `versionName`, `versionCode`, and APK Analyzer
  identity/version come from the generated lock and source-aware Doctor proof.
- `setupActions` and recorded `actions` each contain at most 100 entries.
  `setupActions` must include exactly one `ACP_URL` `fillFromEnvironment` target;
  the adapter supplies its generated loopback value. Recorded actions are
  `wait`, `expect`, `tap`, `fill`, or `back`; only setup also permits
  `fillFromEnvironment` for the three approved ACP field names.
- Android selectors are exact `{ by, value }` objects. `by` is `resourceId`,
  `text`, or `contentDescription`; `value` contains 1-200 characters. React
  Native `testID` values appear verbatim as UIAutomator `resource-id`, including
  bare hyphenated IDs such as `artoo-setup`; conventional package-qualified
  compiled IDs remain supported. Resolution must find exactly one node within
  the adapter's fixed 5-second timeout.
- An Android `wait` uses an integer `ms` from 0 through 10000. A literal `fill`
  contains at most 500 characters and no credential-like material. Every
  non-wait UI action has a fixed 900 ms settle; the only allowed
  `actionSettlingMilliseconds` value is `900`.
- The sum of authored `mobile` durations is the positive recording budget and
  cannot exceed 179 seconds, leaving the 180-second recorder ceiling as
  headroom after media zero. Capture preserves the exact authored duration as
  `targetFrames = ceil(authoredDurationMilliseconds * 30 / 1000)`. The integer
  1-180 second `screenrecord --time-limit` is only a process safety ceiling; it
  is not the media clock, target duration, or frame count. Android `screenrecord`
  has no FPS flag. The adapter uses serial-scoped `adb exec-out screenrecord
  --output-format=h264 ... -`, streams raw Annex-B H.264 into private local
  staging, and performs a lossless local 30/1 FFmpeg remux only after exact
  recorder close, stdout EOF, and sink finalization. There is no remote MP4,
  pull, or remove operation in the scenario contract.
- Consecutive `mobile` scenes require
  `production.transitionMilliseconds: 0`; crossfading the same monotonic mobile
  capture would reorder or duplicate pointer-time ownership. Composition keeps
  the same check as a defense in depth.
- Browser-extension scenarios provide `extension.expectedId` and strict
  declarative `actions`. The capture stage builds and locks the canonical
  extension package from the current worktree. `uploadConnection` targets the
  visible upload trigger; the runner highlights its click and handles the native
  file chooser atomically with a temporary token-free registry.
  `configureBearer` transfers the bearer token from `ACP_BEARER_TOKEN` directly
  into the isolated extension profile and reloads the native panel; the token
  never appears in the scenario or output.
- Caption timestamps use the final composed video clock. Adjacent story
  segments overlap by `production.transitionMilliseconds`, so each segment
  after the first starts one transition before the preceding segment ends. The
  final duration is the sum of segment durations minus all crossfade overlaps.
  Captions start before they end, do not overlap, remain within that final
  duration, and contain no more than two rendered lines. Width validation uses
  a conservative Red Hat Text glyph model at both 1080p and 720p; character
  count alone is not a fit guarantee.
- Author card duration on the `title` and `end` story segments. The generated
  template defaults each to 3 seconds. `production.title`, `subtitle`,
  `endTitle`, and `endText` author card copy; transition duration defaults to
  300 ms.
- Source paths resolve inside the scenario workspace unless explicitly allowed
  by repository policy.

The machine-readable contract is `schema/scenario.schema.json`. Validation must
apply the schema plus semantic rules that JSON Schema cannot express by itself.

## Locked manifest

Resolve the authoring file into `manifest.lock.json`. Include:

- output-relative artifact paths, with no local username or home-directory data;
- extension SHA-256 and verified ID;
- calculated rectangles for every output profile;
- exact tool and browser versions;
- ordered story and caption timings;
- ACP project name and non-secret ownership marker for browser runs, and for
  Android runs only when an `ACP_PROJECT` control is authored;
- input asset digests.

For Android runs, also publish generic `artifacts.mobileCapture`,
`artifacts.pointerEvents`, and `artifacts.androidApkLock` entries plus
`capture.source`. The source records `type: mobile`, positive portrait width and
height, landmarks, and bounded validation evidence. Composition consumes only
`artifacts.mobileCapture`, `artifacts.pointerEvents`, and `capture.source`.
`artifacts.androidApkLock` is retained provenance evidence for validation, not a
media input. Private marker, AVD, SDK, and kubeconfig paths never cross the
capture boundary.

Exclude tokens, cookies, auth headers, environment dumps, browser profile data,
and internal response bodies.
