import { createHash } from "node:crypto";

export const STABLE_EXTENSION_ID = "bjlckanpiblmfadkmknbbpeenckfdgpi";

export class ExtensionGateError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExtensionGateError";
  }
}

function decodeManifestKey(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ExtensionGateError("extension manifest key is missing");
  }
  const compact = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new ExtensionGateError("extension manifest key is not valid base64");
  }
  const decoded = Buffer.from(compact, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== compact) {
    throw new ExtensionGateError("extension manifest key is not canonical base64");
  }
  return decoded;
}

export function manifestKeySha256(manifest) {
  return createHash("sha256").update(decodeManifestKey(manifest?.key)).digest("hex");
}

export function extensionIdFromManifest(manifest) {
  const digest = createHash("sha256").update(decodeManifestKey(manifest?.key)).digest();
  let id = "";
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f));
  }
  return id;
}

export function assertStableExtensionId(manifest, expectedId = STABLE_EXTENSION_ID) {
  const actualId = extensionIdFromManifest(manifest);
  if (actualId !== expectedId) {
    throw new ExtensionGateError(
      `extension identity mismatch: expected ${expectedId}, got ${actualId}`,
    );
  }
  return actualId;
}
