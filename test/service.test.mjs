import test from "node:test";
import assert from "node:assert/strict";
import { readSystemTime } from "../scripts/service.mjs";

test("Clockkeeper returns exactly one sampled system-time reading", () => {
  let samples = 0;
  const result = readSystemTime({ now: () => { samples += 1; return 1_784_781_200_123; } });
  assert.equal(samples, 1);
  assert.equal(result.observedAt, "2026-07-23T04:33:20.123Z");
  assert.equal(result.epochMilliseconds, 1_784_781_200_123);
  assert.equal(result.clock, "system-realtime");
  assert.equal(result.precisionMilliseconds, 1);
});

test("Clockkeeper rejects invalid operating-system readings", () => {
  assert.throws(() => readSystemTime({ now: () => -1 }), /invalid epoch millisecond/);
});
