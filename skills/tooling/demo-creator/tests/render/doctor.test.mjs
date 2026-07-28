import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { renderDoctor } from "../../scripts/render/doctor.mjs";

test("doctor only gates explicitly required renderer groups", async (context) => {
  const root = join(tmpdir(), `demo-doctor-${process.pid}-${Date.now()}`);
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  for (const path of [
    "assets/fonts/RedHatDisplay-Bold.ttf",
    "assets/fonts/RedHatText-Regular.ttf",
    "assets/fonts/RedHatText-Bold.ttf",
    "assets/fonts/RedHatMono-Regular.ttf",
    "assets/fonts/RedHatMono-Bold.ttf",
    "assets/branding/acp-logo.svg",
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "fixture");
  }
  const report = await renderDoctor({ skillRoot: root, required: ["cards"] });
  assert.equal(report.required[0], "cards");
  assert.equal(report.checks.filter((check) => check.name.startsWith("assets/")).every((check) => check.ok), true);
  assert.equal(report.ok, report.checks.find((check) => check.name === "browser").ok);
});

test("card doctor does not require the slide-only bold mono font", async (context) => {
  const root = join(tmpdir(), `demo-card-doctor-${process.pid}-${Date.now()}`);
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  for (const path of [
    "assets/fonts/RedHatDisplay-Bold.ttf",
    "assets/fonts/RedHatText-Regular.ttf",
    "assets/fonts/RedHatText-Bold.ttf",
    "assets/fonts/RedHatMono-Regular.ttf",
    "assets/branding/acp-logo.svg",
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "fixture");
  }
  const report = await renderDoctor({ skillRoot: root, required: ["cards"] });
  assert.equal(report.checks.find((check) => check.name === "assets/fonts/RedHatMono-Bold.ttf").ok, false);
  assert.equal(report.ok, report.checks.find((check) => check.name === "browser").ok);
});
