const HOST_PROCESS_OUTPUT_BYTES = 16 * 1024;

function requirePositivePid(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Host process PID must be a positive integer");
  }
  return value;
}

function boundedStdout(result, pid) {
  const output = result?.stdout ?? result;
  if (typeof output !== "string" && !Buffer.isBuffer(output)) {
    throw new Error(`ps identity for ${pid} did not return bounded stdout`);
  }
  const text = String(output);
  if (Buffer.byteLength(text, "utf8") > HOST_PROCESS_OUTPUT_BYTES) {
    throw new Error(`ps identity for ${pid} exceeds ${HOST_PROCESS_OUTPUT_BYTES} bytes`);
  }
  return text;
}

function parseHostProcessIdentity(result, pid) {
  const output = boundedStdout(result, pid).trimEnd();
  const match = /^(.{24})\s+([^\r\n]+)$/u.exec(output);
  if (!match) throw new Error("Host process inspection result is ambiguous");
  return Object.freeze({
    pid,
    processStartIdentity: match[1],
    command: match[2],
    alive: true,
  });
}

export function createHostProcessInspector({ runCommand, commandOptions }) {
  if (typeof runCommand !== "function") throw new Error("runCommand must be a function");
  if (!commandOptions || typeof commandOptions !== "object" || Array.isArray(commandOptions)) {
    throw new Error("Host process commandOptions must be an object");
  }
  const options = Object.freeze({ ...commandOptions });
  return async (authoredPid) => {
    const pid = requirePositivePid(authoredPid);
    let result;
    try {
      result = await runCommand(
        "/bin/ps",
        ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="],
        options,
      );
    } catch (error) {
      if (typeof error?.code === "number" && error.code === 1) return null;
      throw new Error("Host process inspection failed");
    }
    return parseHostProcessIdentity(result, pid);
  };
}

export { HOST_PROCESS_OUTPUT_BYTES };
