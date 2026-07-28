import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findSecrets, findSensitiveFields, redactText, scanFiles } from "../../scripts/core/security.mjs";

test("secret scanner identifies and redacts auth headers without exposing values", () => {
  const input = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz";
  const findings = findSecrets(input);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "authorization-header");
  assert.equal(redactText(input), "[REDACTED]");
});

test("ordinary demo copy is not treated as a credential", () => {
  assert.deepEqual(findSecrets("Upload the connection file and open the side panel."), []);
});

test("secret scanner detects quoted JSON credential fields without broadening prose matches", () => {
  const input = '{"password": "abcdefghijklmnop", "apiKey": "qrstuvwxyzabcdef", "token": "short-but-sensitive"}';
  assert.deepEqual(findSecrets(input).map(({ id }) => id), ["generic-secret", "generic-secret", "generic-secret"]);
  assert.doesNotMatch(redactText(input), /abcdefghijklmnop|qrstuvwxyzabcdef|short-but-sensitive/);
  assert.deepEqual(findSecrets('The label "password" is documentation, not a value.'), []);
});

test("secret scanner ignores JavaScript credential member expressions", () => {
  const source = [
    "access_token: refreshed.access_token,",
    "refresh_token: refreshed.refresh_token,",
    "access_token: value.access_token,",
    "...(value.refresh_token ? { refresh_token: value.refresh_token } : {}),",
    "password = replacementPassword",
    "let access_token = refreshed.access_token;",
    "const client_secret = process.env.CLIENT_SECRET;",
    "var api_key = loadApiKey();",
    "ACCESS_TOKEN = replacement.access_token",
  ].join("\n");
  assert.deepEqual(findSecrets(source), []);
});

test("secret scanner detects quoted JavaScript credential assignments", () => {
  const source = [
    'const password = "abcdefghijklmnop";',
    "let access_token = 'qrstuvwxyzabcdef';",
    'var client_secret = "uvwxyzabcdefghijkl";',
    "api_key = 'ghijklmnopqrstuv';",
  ].join("\n");

  assert.equal(findSecrets(source).length, 4);
  assert.doesNotMatch(redactText(source), /abcdefghijklmnop|qrstuvwxyzabcdef|uvwxyzabcdefghijkl|ghijklmnopqrstuv/);
});

test("secret scanner detects env, YAML, and unquoted-key string literals", () => {
  const env = [
    "ACCESS_TOKEN=abcdefghijklmnop",
    "export CLIENT_SECRET='qrstuvwxyzabcdef'",
    "PASSWORD=uvwxyzabcdefghijkl # synthetic fixture",
  ].join("\n");
  const yaml = [
    "access_token: abcdefghijklmnop",
    "client_secret: qrstuvwxyzabcdef # synthetic fixture",
  ].join("\n");
  const sourceLiteral = "apiKey: 'uvwxyzabcdefghijkl',";

  assert.equal(findSecrets(env).length, 3);
  assert.equal(findSecrets(yaml).length, 2);
  assert.equal(findSecrets(sourceLiteral).length, 1);
  assert.doesNotMatch(redactText(`${env}\n${yaml}\n${sourceLiteral}`), /abcdefghijklmnop|qrstuvwxyzabcdef|uvwxyzabcdefghijkl/);
});

test("secret scanner detects indented and spaced unquoted environment assignments", () => {
  const env = [
    " ACCESS_TOKEN=abcdefghijklmnop",
    "ACCESS_TOKEN = abcdefghijklmnop",
    "export CLIENT_SECRET = qrstuvwxyzabcdef",
    "  PASSWORD = uvwxyzabcdefghijkl # comment",
  ].join("\n");

  assert.equal(findSecrets(env).length, 4);
  assert.doesNotMatch(redactText(env), /abcdefghijklmnop|qrstuvwxyzabcdef|uvwxyzabcdefghijkl/);
});

test("sensitive field names are rejected even when their values are not token-shaped", () => {
  assert.deepEqual(findSensitiveFields({ nested: { token: "short-value" } }), ["$.nested.token"]);
});

test("file scan includes env, JavaScript, and extensionless text while skipping binary data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "demo-secret-scan-"));
  try {
    const secret = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz";
    await writeFile(path.join(directory, ".env.local"), `${secret}\n`);
    await writeFile(path.join(directory, "script.mjs"), `// ${secret}\n`);
    await writeFile(path.join(directory, "transcript"), `${secret}\n`);
    await writeFile(path.join(directory, "binary"), Buffer.from([0, 1, 2, 3]));
    const findings = await scanFiles(directory);
    assert.deepEqual(findings.map(({ file }) => path.basename(file)).sort(), [".env.local", "script.mjs", "transcript"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file scan fails closed when a candidate text file exceeds its bound", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "demo-secret-bound-"));
  try {
    await writeFile(path.join(directory, "large.log"), "x".repeat(65));
    const findings = await scanFiles(directory, { maxFileBytes: 64 });
    assert.deepEqual(findings.map(({ id }) => id), ["scan-size-limit"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file scan stops at maxFiles without materializing the complete tree", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "demo-secret-files-"));
  try {
    await writeFile(path.join(directory, "one.txt"), "safe\n");
    await writeFile(path.join(directory, "two.txt"), "safe\n");
    await writeFile(path.join(directory, "three.txt"), "safe\n");
    const findings = await scanFiles(directory, { maxFiles: 2 });
    assert.deepEqual(findings, [{
      file: path.resolve(directory),
      id: "scan-file-limit",
      index: 0,
      length: 0,
    }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
