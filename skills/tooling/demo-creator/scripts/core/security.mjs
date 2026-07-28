import { open, readdir } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_EXTENSIONS = Object.freeze([
  ".json", ".yaml", ".yml", ".txt", ".vtt", ".srt", ".ass", ".log",
  ".html", ".md", ".tape", ".cast", ".csv", ".js", ".mjs", ".cjs",
  ".jsx", ".ts", ".tsx",
]);

const SECRET_PATTERNS = Object.freeze([
  { id: "authorization-header", regex: /\b(?:authorization\s*:\s*)?bearer\s+[a-z0-9._~+\/-]{16,}/gi },
  { id: "jwt", regex: /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g },
  { id: "private-key", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { id: "generic-secret", regex: /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*:\s*(["'])[a-z0-9_./+~ -]{12,}\1/gi },
  { id: "generic-secret", regex: /^[ \t]*(?:(?:export|const|let|var)[ \t]+)?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)[ \t]*=[ \t]*(["'])[a-z0-9_./+~ -]{12,}\1[ \t]*;?[ \t]*(?:(?:#|\/\/)[^\r\n]*)?$/gim },
  { id: "generic-secret", regex: /^[ \t]*(?:export[ \t]+)?(?:API[_-]?KEY|ACCESS[_-]?TOKEN|CLIENT[_-]?SECRET|PASSWORD)[ \t]*=[ \t]*(?![a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)+[ \t]*(?:#[^\r\n]*)?$)[a-zA-Z0-9_./+~-]{12,}[ \t]*(?:#[^\r\n]*)?$/gm },
  { id: "generic-secret", regex: /^[ \t]*(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)[ \t]*:[ \t]*[a-z0-9_./+~-]{12,}[ \t]*(?:#[^\r\n]*)?$/gim },
  { id: "generic-secret", regex: /"(?:authorization|bearer|password|token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)"\s*:\s*"[^"\r\n]+"/gi },
]);

export function findSecrets(text) {
  const value = String(text);
  const findings = [];
  for (const { id, regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    for (const match of value.matchAll(regex)) {
      findings.push({ id, index: match.index, length: match[0].length });
    }
  }
  return findings;
}

export function redactText(text) {
  let result = String(text);
  for (const { regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    result = result.replace(regex, "[REDACTED]");
  }
  return result;
}

export function findSensitiveFields(value, location = "$") {
  const findings = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => findings.push(...findSensitiveFields(item, `${location}[${index}]`)));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childLocation = `${location}.${key}`;
      if (/^(?:authorization|bearer|password|token|accessToken|refreshToken|apiKey|clientSecret)$/i.test(key) && child !== "" && child !== null && child !== undefined) {
        findings.push(childLocation);
      } else {
        findings.push(...findSensitiveFields(child, childLocation));
      }
    }
  }
  return findings;
}

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(fullPath);
    else if (entry.isFile()) yield fullPath;
  }
}

function isTextCandidate(file, extensions) {
  const basename = path.basename(file).toLowerCase();
  const extension = path.extname(basename);
  return basename === ".env" || basename.startsWith(".env.") || extension === "" || extensions.includes(extension);
}

async function readBoundedUtf8(file, maxFileBytes) {
  const handle = await open(file, "r");
  try {
    const details = await handle.stat();
    if (!details.isFile()) return { skipped: true };
    if (details.size > maxFileBytes) return { tooLarge: true };
    const buffer = Buffer.alloc(details.size);
    let offset = 0;
    while (offset < details.size) {
      const { bytesRead } = await handle.read(buffer, offset, details.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const contents = buffer.subarray(0, offset);
    if (contents.includes(0)) return { skipped: true };
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(contents) };
    } catch {
      return { skipped: true };
    }
  } finally {
    await handle.close();
  }
}

export async function scanFiles(root, {
  extensions = DEFAULT_EXTENSIONS,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
} = {}) {
  if (!Number.isInteger(maxFileBytes) || maxFileBytes <= 0) throw new Error("maxFileBytes must be a positive integer");
  if (!Number.isInteger(maxFiles) || maxFiles <= 0) throw new Error("maxFiles must be a positive integer");
  const findings = [];
  let fileCount = 0;
  for await (const file of walk(root)) {
    fileCount += 1;
    if (fileCount > maxFiles) {
      return [{ file: path.resolve(root), id: "scan-file-limit", index: 0, length: 0 }];
    }
    if (!isTextCandidate(file, extensions)) continue;
    const result = await readBoundedUtf8(file, maxFileBytes);
    if (result.tooLarge) {
      findings.push({ file, id: "scan-size-limit", index: 0, length: 0 });
      continue;
    }
    if (result.skipped) continue;
    const text = result.text;
    for (const finding of findSecrets(text)) findings.push({ file, ...finding });
  }
  return findings;
}
