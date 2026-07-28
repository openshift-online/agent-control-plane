const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function matchesPortableSource(source) {
  return exactKeys(source, ["commit", "path", "tree"])
    && GIT_OBJECT_ID.test(source.commit)
    && GIT_OBJECT_ID.test(source.tree)
    && source.path === "components/mobile";
}

export function androidApkLockMatches(lock, apk) {
  if (!exactKeys(lock, ["apkanalyzer", "apk", "schemaVersion", "source"])
    || lock.schemaVersion !== 1
    || !matchesPortableSource(lock.source)
    || !exactKeys(lock.apk, ["applicationId", "ref", "sha256", "versionCode", "versionName"])
    || !exactKeys(lock.apkanalyzer, ["identity", "version"])
    || typeof lock.apk.ref !== "string"
    || !SHA256.test(lock.apk.sha256 ?? "")
    || typeof lock.apk.applicationId !== "string"
    || typeof lock.apk.versionName !== "string"
    || typeof lock.apk.versionCode !== "string"
    || typeof lock.apkanalyzer.identity !== "string"
    || typeof lock.apkanalyzer.version !== "string") {
    return false;
  }
  return matchesPortableSource(apk?.source)
    && lock.source.commit === apk.source.commit
    && lock.source.tree === apk.source.tree
    && lock.source.path === apk.source.path
    && lock.apk.ref === apk.ref
    && lock.apk.sha256 === apk.sha256
    && lock.apk.applicationId === apk.applicationId
    && lock.apk.versionName === apk.versionName
    && lock.apk.versionCode === apk.versionCode
    && lock.apkanalyzer.identity === apk.apkanalyzer?.identity
    && lock.apkanalyzer.version === apk.apkanalyzer?.version;
}

export function assertAndroidApkLock(lock, apk, message = "Android APK lock does not match capture provenance") {
  if (!androidApkLockMatches(lock, apk)) throw new Error(message);
  return lock;
}
