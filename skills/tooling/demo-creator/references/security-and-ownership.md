# Security and ACP ownership

## Credential flow

Browser capture allows exactly these ACP environment inputs:

- `ACP_URL`
- `ACP_PROJECT`
- `ACP_BEARER_TOKEN`

Android pre-recording `fillFromEnvironment` uses that same three-field
vocabulary. Advanced bearer setup may select `ACP_BEARER_TOKEN`. OIDC remains
the app's system-browser PKCE flow; the skill never collects an OIDC or
identity-provider username or password.

No Android recorded action may use `fillFromEnvironment`. Author exactly one
`ACP_URL` setup target, but derive its value from the owned Kind port-forward and
serial-bound ADB reverse rather than caller environment. Transfer each other
setup value through private stdin to the device driver. Never put a credential
value in host process arguments, the scenario, a generated command, or retained
UI automation evidence.

When a real client project control is authored, `ACP_PROJECT` is non-secret and
must intentionally duplicate `acp.project` in the validated scenario.
Projectless Android onboarding omits both. No credential value may be duplicated
there. Parse the
adapter-generated `ACP_URL` as an exact origin without credentials, a path,
query, or fragment.
Require HTTPS except when the parsed hostname is `localhost`, `::1`, or in the
`127.0.0.0/8` loopback range. Validate the parsed hostname, not a string prefix,
before accepting plain HTTP.

Treat every value as sensitive in logs even though the project name and derived
loopback URL are non-secret. Pass credentials only to the process that needs
them, redact HTTP auth headers, and never print environment dumps.

Reject credentials in scenarios, slide Markdown, VHS tapes, captions, fixture
files, browser automation source, and CLI arguments. Scan raw and final artifacts
for known inputs and common token patterns before reporting success.

## Temporary state

- Create browser profiles and intermediate auth material with user-only
  permissions.
- Use a fresh profile per run.
- Do not copy cookies or local storage from the user's regular browser.
- Always purge a profile and temporary files after a bearer token enters that
  profile, including on capture failure. Retention options must refuse this
  combination.
- Keep failed-run diagnostics only after redaction; state clearly when manual
  cleanup is required.
- Stream Android recorder stdout only into an exclusively created mode-0600 raw
  H.264 file under the run's owned mode-0700 staging directory. Never publish its
  path or bytes. Remove the exact staging directory after success and after a
  failure only when child close, stdout EOF, and writer quiescence are proven.
  Preserve the private stage when any of those proofs is uncertain; the run
  fails closed and cannot produce a public mobile capture.

## ACP project lifecycle

For browser capture, and Android capture that authors a real `ACP_PROJECT`
control, derive a stable, scenario-specific reusable project name. Attach an
ownership marker that includes the scenario identity and tool namespace, but no
personal or credential data.

Before seed, reset, or cleanup:

1. Read the project through the documented API or `acpctl`.
2. Verify the exact expected ownership marker.
3. Refuse the operation when the marker is absent, malformed, or belongs to a
   different scenario.
4. Limit mutations to resources declared by the scenario.

Never infer ownership from a name prefix alone. `--keep-project` changes the
reported retention intent, but cleanup must still read the project and verify
its exact ownership markers and deterministic fields.

ACP projects are soft-deleted, while both the project ID and the unique name are
the stable scenario name. The current API hides a deleted project from GET and
list but still rejects a new POST with that name. Default cleanup must therefore
verify the exact ownership markers and retain the deterministic project record
for reuse. Do not call project DELETE until ACP provides a supported way to
recreate or restore the same stable name. A name tombstoned by an older run
requires a one-time database repair or a clean ACP data store; choosing an
alternate project name would bypass the scenario ownership contract.

The version 1 browser lifecycle manages only this project envelope. It does not
find, reset, or delete agents, sessions, credentials, providers, settings, or
other project-scoped child resources. Browser scenarios must not create those
resources. Add a declared resource-specific cleanup adapter before expanding a
browser scenario; retaining the envelope must never be described as cleaning
unknown child state. Android may create child state only inside the whole
disposable Kind cluster that the Android adapter verifies and deletes.

Every ownership-gated mutation must be guarded by an atomic compare-and-swap
that fails closed: acquire an exclusive claim, mutate only while that claim still
proves the observed state, and abort the entire operation on any mismatch,
contention, or uncertainty instead of proceeding on a stale read. The local run
enforces this with the manifest writer lease in `scripts/core/manifest.mjs`,
which claims work through an exclusive `open(path, "wx")` create, verifies the
stored token before release, and publishes only through a temp-file `rename`, so
a competing writer is rejected atomically rather than racing.

The current ACP project API exposes no ETag, resource version, or other
conditional-update contract, so the lifecycle adapter cannot yet make the remote
PATCH itself atomic. Until ACP provides a server-side conditional mutation, the
adapter re-reads the project immediately before PATCH, compares the
mutation-relevant fingerprint, refuses to mutate on any difference, and
re-verifies state afterward. Treat this as a fail-closed stopgap, not a fix: the
remaining time-of-check/time-of-use window is eliminated only when the mutation
becomes a server-enforced compare-and-swap.

## Android APK trust and installation

Bind Task 3's generated APK lock to the exact clean `HEAD` commit, full
`HEAD^{tree}`, and `components/mobile` source path. Require matching embedded
commit, tree, and lock-schema metadata plus the locked APK digest and analyzed
package identity. Task 3 has not yet exposed a callable canonical rebuild
verifier, so this generated lock is the current trust anchor; do not invent a
local verifier interface or claim an independent rebuild.

Copy the verified bytes into a randomized mode-0700 directory and mode-0400
file. APK Analyzer may inspect that private pathname under pre/post identity
checks. Installation is stricter: open and prove the exact snapshot inode,
inherit that read-only descriptor as bounded standard input to
`cmd package install -S`, and never expose or reopen an APK pathname through
ADB or Package Manager. Keep tool environments allowlisted and all errors free
of private paths.

## Android lifecycle ownership

Android capture owns two disposable resources and stores each marker outside
the resource it guards as a regular mode-0600 file. Caller-authored cluster,
AVD, context, serial, port, or PID identities are forbidden.

The Kind reservation marker contains exactly `version`, `toolNamespace`,
`scenarioId`, `runId`, `nonce`, and generated `clusterName`, with
`toolNamespace: acp.demo-creator.android.kind`. Binding adds exactly
`kubeContext`, `kubeServer`, and canonical `containerIdentities`. Before any
mutation and again immediately before teardown, re-read the marker and require
one live cluster whose generated name, context, server, and container identities
exactly match. Missing, extra, changed, duplicate, or ambiguous identity fails
closed without deleting anything. Successful teardown deletes the entire
disposable cluster, freshly proves the exact name, context, API server, and
container identities are all absent, and only then removes its marker.

Immediately before `kind-up`, a one-use creation transaction re-reads the
reservation marker and proves the generated cluster and context absent.
The `kind-up` operation completes that opaque transaction with the exact
context and server it observes plus immutable Docker container IDs proven by
the create/destroy event window around that exact invocation. The repository
setup requires those created IDs to equal the final live set exactly and to
describe exactly one control-plane node; extra, replaced, destroyed, or
wrong-role containers fail closed without publishing a proof. Binding requires
that witness plus two matching post-create
snapshots. If `kind-up` or binding fails before
those identities are durably bound, the runner boundedly re-reads the completed
creation proof. A valid proof is attached non-enumerably to the static Make
error so capture can complete the original one-use transaction, reverify and
bind the exact live identities, then perform immutable-ID cleanup while
preserving the deployment error. Missing, changed, or ambiguous proof never
authorizes deletion: cleanup never invokes name-only `kind-down`, removes the
marker only after two fresh absence proofs, and otherwise preserves both the
marker and ambiguous runtime for diagnosis.

The strict Docker-only `kind-down` path receives the canonical witnessed
container IDs through its closed Make environment, freshly re-enumerates the
cluster label, requires exact set equality, and force-removes only those
immutable IDs. It then removes only the exact entries from the run-private
kubeconfig. It never deletes a cluster or Docker network by name; the shared
Kind network is outside the demo ownership boundary.

Materialize the exact clean committed tree into a fresh mode-0700 run-private
workspace before invoking Make. Set Make's home, temporary, XDG, kubeconfig,
connection-registry, port-forward-state, and legacy-state paths inside that
runtime boundary. Require new-cluster creation so the repository setup cannot
adopt a same-name cluster that appeared after reservation. Because ownership
is proven through Docker identities, the strict demo cleanup forbids fallback
to Podman clusters or containers.

Do not pass an authored `ACP_URL` to the app. Prove the private connection
descriptor and bound port-forward process for the exact owned Kind cluster,
then create an exact serial-bound ADB reverse. Inject only the derived
`http://127.0.0.1:<owned-device-port>` origin into the pre-recording `ACP_URL`
action. Reverify and remove that reverse mapping, with an absence proof, before
tearing down the AVD.

The AVD reservation marker contains exactly `version`, `toolNamespace`,
`scenarioId`, `runId`, `nonce`, generated `avdName`, canonical `avdPath`, and
`systemImage`, with `toolNamespace: acp.demo-creator.android-avd`. Process binding
adds exactly `serial`, `consolePort`, `pid`, and `processStartIdentity`. Require
one live AVD whose name/path/image/config match and, once bound, one emulator
whose AVD, serial, port, PID, and process-start identity match. Reverify the
external marker and live state immediately before the first ADB mutation and
teardown. Any mismatch or ambiguity fails closed; never kill by PID alone.

The first process `SIGINT` or `SIGTERM` requests cooperative cancellation and
reaches bounded `finally` cleanup; a second signal may hard-exit. When mutation
or child quiescence remains unproved, preserve the exact runtime resources and
their ownership markers for manual recovery instead of risking unsafe deletion.

Cleanup runs in reverse acquisition order: stop the exact recorder child and
prove child close, stdout EOF, queued-write completion, and raw-file sync; remove
the private recorder staging after validation/publication or a
proven-quiescent failure, otherwise preserve it privately; remove and prove
absence of the exact ADB reverse; delete the exact owned emulator and AVD; then
delete the exact owned Kind cluster through
the repository-approved teardown path. Preserve the primary failure and report
cleanup failures separately; do not broaden cleanup to unrelated resources.

## Media hygiene

Inspect captions, transcripts, logs, reports, images, contact sheets, video
frames, and media metadata. Do not record notification centers, password
managers, unrelated tabs, bookmarks, user avatars, camera feeds, microphones,
or desktop areas outside the intended browser window.

The visual security gate requires local Tesseract OCR. It examines every image
and a bounded, evenly spaced sample of every video. The gate fails closed when
Tesseract, FFmpeg, or FFprobe cannot perform that inspection. OCR text is
scanned in memory and is never written to the output directory or report.
Sampled OCR is defense in depth, not proof that visual media contains no secret
or personal data. A human must review the final video and contact sheet before
every public release.
