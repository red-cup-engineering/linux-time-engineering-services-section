#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function readSystemTime({ now = Date.now } = {}) {
  const epochMilliseconds = now();
  if (!Number.isSafeInteger(epochMilliseconds) || epochMilliseconds < 0) throw new Error("system clock returned an invalid epoch millisecond reading");
  return Object.freeze({
    observedAt: new Date(epochMilliseconds).toISOString(),
    epochMilliseconds,
    clock: "system-realtime",
    precisionMilliseconds: 1,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = readSystemTime();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
