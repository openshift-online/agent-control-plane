import assert from "node:assert/strict";
import test from "node:test";
import {
  CALLER_SENSITIVE_ENVIRONMENT,
  sanitizedSubprocessEnvironment,
} from "../../scripts/compose/security-values.mjs";

test("every caller-sensitive variable is removed from the subprocess environment", () => {
  const base = { PATH: "/usr/bin", LANG: "C" };
  for (const name of CALLER_SENSITIVE_ENVIRONMENT) base[name] = "secret-value";
  const scrubbed = sanitizedSubprocessEnvironment(base);
  for (const name of CALLER_SENSITIVE_ENVIRONMENT) {
    assert.equal(name in scrubbed, false, `${name} must not survive scrubbing`);
  }
  assert.equal(scrubbed.PATH, "/usr/bin");
  assert.equal(scrubbed.LANG, "C");
});

test("a generic override can never reintroduce a sensitive name into the child environment", () => {
  const [name] = CALLER_SENSITIVE_ENVIRONMENT;
  // A caller that passes {env: process.env} (or any override map still carrying
  // the token) must not leak it: scrubbing applies to the final merged env.
  const scrubbed = sanitizedSubprocessEnvironment({ [name]: "inherited" }, { [name]: "override" });
  assert.equal(name in scrubbed, false, `${name} must not survive an override`);
});

test("scrubbing does not mutate the caller-provided base environment", () => {
  const [name] = CALLER_SENSITIVE_ENVIRONMENT;
  const base = { [name]: "secret-value", PATH: "/usr/bin" };
  sanitizedSubprocessEnvironment(base);
  assert.equal(base[name], "secret-value");
});

test("the default base is the live process environment", () => {
  const [name] = CALLER_SENSITIVE_ENVIRONMENT;
  const priorToken = Object.prototype.hasOwnProperty.call(process.env, name)
    ? process.env[name]
    : undefined;
  process.env[name] = "live-secret";
  process.env.DEMO_CREATOR_SECURITY_PROBE = "kept";
  try {
    const scrubbed = sanitizedSubprocessEnvironment();
    assert.equal(name in scrubbed, false);
    assert.equal(scrubbed.DEMO_CREATOR_SECURITY_PROBE, "kept");
  } finally {
    if (priorToken === undefined) delete process.env[name];
    else process.env[name] = priorToken;
    delete process.env.DEMO_CREATOR_SECURITY_PROBE;
  }
});
