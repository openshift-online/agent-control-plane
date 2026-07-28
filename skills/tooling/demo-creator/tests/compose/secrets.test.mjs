import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { scanOutputSecrets, scanTextForSecrets } from "../../scripts/compose/secrets.mjs";

const execFileAsync = promisify(execFile);

async function liveVisualToolsAvailable() {
  try {
    const [{ stdout, stderr }] = await Promise.all([
      execFileAsync("ffmpeg", ["-hide_banner", "-filters"]),
      execFileAsync("tesseract", ["--version"]),
    ]);
    return /\bdrawtext\b/.test(`${stdout}\n${stderr}`);
  } catch {
    return false;
  }
}

const hasLiveVisualTools = await liveVisualToolsAvailable();

test("secret scan identifies credentials without returning their full value", () => {
  const token = "eyJhbGciOiJSUzI1NiJ9.abcdefghijklmno.zyxwvutsrqponml";
  const findings = scanTextForSecrets(`Authorization: Bearer ${token}`, "captions.vtt");
  assert.ok(findings.length >= 1);
  assert.ok(findings.every((finding) => !finding.evidence.includes(token)));
  assert.ok(findings.every((finding) => finding.evidence === "[redacted]"));
});

test("synthetic prose is not treated as a credential", () => {
  assert.deepEqual(scanTextForSecrets("The token field stays collapsed by default."), []);
});

test("exact configured values and common encodings are detected without publishing the values", () => {
  const configuredValue = "oidc-user+demo@example.invalid";
  const representations = [
    configuredValue,
    JSON.stringify(configuredValue).slice(1, -1),
    encodeURIComponent(configuredValue),
    Buffer.from(configuredValue, "utf8").toString("base64"),
    Buffer.from(configuredValue, "utf8").toString("base64url"),
  ];
  for (const representation of new Set(representations)) {
    const findings = scanTextForSecrets(`visible=${representation}`, "fixture", {
      sensitiveValues: [configuredValue],
    });
    assert.ok(findings.some(({ pattern }) => pattern === "configured-value"));
    assert.ok(representations.every((value) => !JSON.stringify(findings).includes(value)));
  }
});

test("exact configured values are scanned in retained metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-exact-metadata-"));
  const configuredValue = "mobile-oidc-user-4812";
  try {
    const encoded = Buffer.from(configuredValue, "utf8").toString("base64");
    const result = await scanOutputSecrets(root, {
      metadata: [{ source: "capture-metadata", value: { display: encoded } }],
      sensitiveValues: [configuredValue],
    });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some(({ source, pattern }) => (
      source === "capture-metadata" && pattern === "configured-value"
    )));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(configuredValue, "u"));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(encoded, "u"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("exact configured values are redacted from finding source and overlapping generic evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-exact-finding-redaction-"));
  const configuredValue = "exact-password-4812";
  const encoded = Buffer.from(configuredValue, "utf8").toString("base64");
  try {
    await fs.writeFile(
      path.join(root, `${configuredValue}.txt`),
      `password=${configuredValue}\nencoded=${encoded}\n`,
    );
    const result = await scanOutputSecrets(root, { sensitiveValues: [configuredValue] });
    const serialized = JSON.stringify(result);
    assert.equal(result.ok, false);
    assert.ok(result.findings.some(({ pattern }) => pattern === "generic-secret"));
    assert.ok(result.findings.some(({ pattern }) => pattern === "configured-value"));
    assert.equal(serialized.includes(configuredValue), false);
    assert.equal(serialized.includes(encoded), false);
    assert.ok(result.findings.every(({ evidence }) => evidence === "[configured value redacted]"));
    assert.ok(result.findings.every(({ source }) => source === "[redacted].txt"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("exact configured values are scanned in image OCR", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-exact-image-"));
  const configuredValue = "mobile-password-4812";
  const encoded = encodeURIComponent(configuredValue);
  try {
    await fs.writeFile(path.join(root, "contact-sheet.png"), "fixture");
    const result = await scanOutputSecrets(root, {
      sensitiveValues: [configuredValue],
      execute: async () => ({ stdout: `visible=${encoded}`, stderr: "" }),
    });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some(({ source, pattern }) => (
      source === "contact-sheet.png#ocr" && pattern === "configured-value"
    )));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(configuredValue, "u"));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(encoded, "u"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("exact configured values are scanned in sampled video-frame OCR", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-exact-video-"));
  const configuredValue = "mobile-token-value-4812";
  const encoded = Buffer.from(configuredValue, "utf8").toString("base64url");
  try {
    await fs.writeFile(path.join(root, "demo.mp4"), "fixture");
    const result = await scanOutputSecrets(root, {
      maxVideoFrames: 2,
      sensitiveValues: [configuredValue],
      execute: async (command, args) => {
        if (command === "ffprobe") return { stdout: "2\n", stderr: "" };
        if (command === "ffmpeg") {
          await fs.writeFile(args.at(-1).replace("%04d", "0001"), "frame");
          return { stdout: "", stderr: "" };
        }
        if (command === "tesseract") return { stdout: `visible=${encoded}`, stderr: "" };
        throw new Error(`unexpected command: ${command}`);
      },
    });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some(({ source, pattern }) => (
      source === "demo.mp4#frame-1" && pattern === "configured-value"
    )));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(configuredValue, "u"));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(encoded, "u"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("image OCR is mandatory and secret findings remain redacted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-visual-image-"));
  try {
    await fs.writeFile(path.join(root, "contact-sheet.png"), "fixture");
    const token = "eyJhbGciOiJSUzI1NiJ9.abcdefghijklmno.zyxwvutsrqponml";
    const calls = [];
    const result = await scanOutputSecrets(root, {
      execute: async (command, args) => {
        calls.push({ command, args });
        return { stdout: `Authorization: Bearer ${token}`, stderr: "" };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.visualScan.required, true);
    assert.equal(result.visualScan.images, 1);
    assert.equal(calls[0].command, "tesseract");
    assert.ok(result.findings.every((finding) => !finding.evidence.includes(token)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("video frames are sampled, OCRed, and counted through an injectable runner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-visual-video-"));
  try {
    await fs.writeFile(path.join(root, "demo.mp4"), "fixture");
    const commands = [];
    let ffmpegArgs;
    const result = await scanOutputSecrets(root, {
      maxVideoFrames: 4,
      execute: async (command, args) => {
        commands.push(command);
        if (command === "ffprobe") return { stdout: "12\n", stderr: "" };
        if (command === "ffmpeg") {
          ffmpegArgs = args;
          const pattern = args.at(-1);
          await fs.writeFile(pattern.replace("%04d", "0001"), "frame");
          return { stdout: "", stderr: "" };
        }
        if (command === "tesseract") return { stdout: "No credentials visible.", stderr: "" };
        throw new Error(`unexpected command: ${command}`);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.visualScan.videos, 1);
    assert.equal(result.visualScan.sampledFrames, 1);
    assert.deepEqual(commands, ["ffprobe", "ffmpeg", "tesseract"]);
    assert.ok(ffmpegArgs.includes("fps=1/3.000000,scale=1920:-2:force_original_aspect_ratio=decrease:flags=lanczos"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("visual inspection fails closed when OCR cannot run", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-visual-failure-"));
  try {
    await fs.writeFile(path.join(root, "frame.png"), "fixture");
    const result = await scanOutputSecrets(root, {
      execute: async () => {
        throw new Error("missing OCR tool");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.visualScan.ok, false);
    assert.deepEqual(result.findings.map((finding) => finding.pattern), ["visual-scan-error"]);
    assert.doesNotMatch(JSON.stringify(result), /missing OCR tool/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test(
  "live OCR detects a credential rendered only in contact-sheet pixels",
  { skip: hasLiveVisualTools ? false : "FFmpeg drawtext and Tesseract are required" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-live-visual-secret-"));
    try {
      const image = path.join(root, "contact-sheet.png");
      const font = path.resolve(new URL("../../assets/fonts/RedHatMono-Bold.ttf", import.meta.url).pathname);
      await execFileAsync("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=white:s=2400x600",
        "-vf",
        `drawtext=fontfile='${font}':text='AKIAABCDEFGHJKMNPQRS':fontcolor=black:fontsize=160:x=80:y=200`,
        "-frames:v",
        "1",
        image,
      ]);
      const result = await scanOutputSecrets(root);
      assert.equal(result.ok, false);
      assert.equal(result.visualScan.images, 1);
      assert.ok(result.findings.some((finding) => finding.pattern === "aws-access-key"));
      assert.doesNotMatch(JSON.stringify(result), /AKIAABCDEFGHJKMNPQRS/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
