import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

// Extracts a single top-level job block (2-space indented `<name>:` key) from a
// GitHub Actions workflow, up to the next sibling job. Text-based on purpose so
// this regression guard depends only on Node built-ins, matching the rest of
// the demo-creator suite.
function extractJob(content, name) {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) {
    throw new Error(`job '${name}:' not found in workflow`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

// The live OCR regression in compose/secrets.test.mjs renders a synthetic AWS
// access key into image pixels with ffmpeg `drawtext`, then asserts the visual
// secret scanner catches it. That test SKIPS (does not fail) when ffmpeg lacks
// the `drawtext` filter. Since FFmpeg 6.1 `drawtext` requires libharfbuzz and
// Debian/Ubuntu packages have shipped without it while still providing `ass`
// and `libx264`, the CI job must fail-fast on `drawtext` too -- otherwise this
// security-regression test silently skips in CI and reports a false green.
test("CI verifies the ffmpeg drawtext capability required by the live OCR secret-scan skip gate", async () => {
  const skipGateSource = await fs.readFile(
    new URL("./secrets.test.mjs", import.meta.url),
    "utf8",
  );
  // Premise guard: the live OCR test really does gate on drawtext.
  assert.match(
    skipGateSource,
    /drawtext/,
    "expected compose/secrets.test.mjs live OCR skip gate to depend on the ffmpeg drawtext filter",
  );

  const workflow = await fs.readFile(
    new URL("../../../../../.github/workflows/unit-tests.yml", import.meta.url),
    "utf8",
  );
  const demoJob = extractJob(workflow, "demo-creator");

  assert.match(
    demoJob,
    /ffmpeg[^\n]*-filters[^\n]*\|[^\n]*grep[^\n]*drawtext/,
    "unit-tests.yml demo-creator job must fail-fast verify the ffmpeg 'drawtext' filter (as it already does for 'ass'/'libx264'); otherwise the live OCR secret-scan regression in compose/secrets.test.mjs silently skips in CI",
  );
});

// Same false-green class, different workflow: components-build-deploy.yml's
// "Build CI Gate" runs `if: always()` and aggregates its dependencies' results,
// treating `skipped` (and `success`) as green so the fork-skip policy and the
// no-components-changed path stay green. build-matrix is the root job that every
// other build/test job depends on. If build-matrix FAILS or is CANCELLED, GitHub
// skips build-amd64/build-arm64/merge-manifests/test-local-dev (each carries an
// implicit success() gate on its needs, or explicit !failure()/!cancelled()), so
// a gate loop that inspects only those downstream jobs sees four `skipped`
// results and reports "passed (or skipped)": a false green that discards the
// matrix failure ("never silently swallow partial failures").
//
// build-matrix's OWN result is the only signal that distinguishes a broken matrix
// (failure/cancelled) from the legitimate fork-skip (skipped, via build-matrix's
// same-repo `if:` guard). The gate must inspect needs.build-matrix.result inside
// the same failure/cancelled loop, which already lets `skipped` pass through.
test("Build CI Gate rejects a failed or cancelled build-matrix instead of accepting downstream skips as a false green", async () => {
  const workflow = await fs.readFile(
    new URL(
      "../../../../../.github/workflows/components-build-deploy.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const gate = extractJob(workflow, "build-ci-gate");

  // Premise: build-matrix is a declared dependency, so needs.build-matrix.result
  // is available to the gate step.
  assert.match(
    gate,
    /needs:\s*\[[^\]]*build-matrix[^\]]*\]/,
    "build-ci-gate must depend on build-matrix for its result to be inspectable",
  );

  // Premise: the loop rejects only failure/cancelled, so a *skipped* build-matrix
  // (fork PRs, where build-matrix's same-repo `if:` guard skips it) still passes.
  // This is why adding build-matrix to this loop preserves the fork-skip policy.
  assert.match(gate, /\[ "\$result" == "failure" \]/);
  assert.match(gate, /\[ "\$result" == "cancelled" \]/);

  // Regression: the status-check loop must include needs.build-matrix.result.
  const loop = gate.match(/for result in([\s\S]*?);\s*do/);
  assert.ok(
    loop,
    "expected a `for result in ...; do` status-check loop in build-ci-gate",
  );
  assert.match(
    loop[1],
    /needs\.build-matrix\.result/,
    "build-ci-gate status loop must check needs.build-matrix.result; otherwise a failed or cancelled build-matrix skips every downstream job and the gate reports a false green",
  );
});
