import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digest, runDue, settle } from "../src/service.mjs";

const CONTEXT = "https://www.w3.org/ns/activitystreams";
const PROVIDER = "urn:colony:cold-red-gate:clockkeeper";
const CUSTOMER = "https://koios.news/activitypub/actor";
const CAPABILITY = "urn:capability:koios-news:scheduled-issue-pulse:v1";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "scheduled-delivery-test-"));
  const target = join(root, "target"); const dataRoot = join(root, "provider-data"); mkdirSync(target, { recursive: true });
  mkdirSync(join(target, "dist"), { recursive: true });
  writeFileSync(join(target, "dist", "runtime.mjs"), "export const runtimeVersion = 1;\n");
  writeFileSync(join(target, "accept.mjs"), "process.stdout.write(JSON.stringify({type:'Accept',actor:'urn:ame:test-target',object:{type:'Accepted',cwd:process.cwd()}}))\n");
  writeFileSync(join(target, "hang.mjs"), "import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync('child.pid',String(c.pid));setInterval(()=>{},1000);\n");
  writeFileSync(join(target, "package.json"), JSON.stringify({
    type: "module", bin: { "settle-issue-pulse": "./accept.mjs", "hang": "./hang.mjs" },
    "x-agentic-metro-enterprise": { "node-id": "test-target", "operation-catalog": { "settle-issue-pulse": { contract: "test/pulse/v1", timeoutMs: 5000 }, "hang": { contract: "test/hang/v1", timeoutMs: 1000 } } }
  }));
  const targetDescriptor = { packageRoot: target, nodeId: "test-target", actor: "urn:ame:test-target", operation: "settle-issue-pulse", contract: "test/pulse/v1" };
  return { root, target, dataRoot, targetDescriptor };
}

function request(target, executionMode = "live") {
  return {
    type: "ScheduledActivityDeliveryRequest", executionMode,
    schedule: { intervalSeconds: 60, firstDueAt: "2026-07-19T00:00:00.000Z", maxDeliveries: null },
    target, timeoutMilliseconds: 5000, retry: { maxAttempts: 1 }, deliveryCapabilityId: CAPABILITY,
    activityTemplate: { "@context": CONTEXT, type: "Create", target: target.actor, object: { type: "NewsroomIssueDemand", policy: { triggerAuthorities: [{ actor: PROVIDER, capability: CAPABILITY }] }, policyDigest: "sha256:test" } }
  };
}

function solicit(target, dataRoot, at = "2026-07-18T23:59:00.000Z") {
  const source = { "@context": CONTEXT, id: "urn:test:source", type: "Create", actor: CUSTOMER, target: PROVIDER, object: { type: "Note", attachment: [request(target)] } };
  const activity = { "@context": CONTEXT, id: "urn:test:solicitation", type: "Offer", actor: CUSTOMER, target: PROVIDER, object: { type: "ServiceSolicitation", sourceActivity: source } };
  return { activity, offer: settle(activity, "solicit-service", at, { dataRoot }) };
}

function invoke(offer, dataRoot, at = "2026-07-18T23:59:01.000Z") {
  const cap = { type: "Capability", issuer: CUSTOMER, holder: PROVIDER, invocationTarget: PROVIDER, parentOffer: offer.id,
    allowedActions: ["invoke-service", ...offer.object.effects], attenuation: { requestDigest: offer.object.requestDigest, scheduleId: offer.object.scheduleId }, singleUse: true, expiresAt: "2026-07-19T00:30:00.000Z" };
  const activity = { "@context": CONTEXT, id: "urn:test:invocation", type: "Accept", actor: CUSTOMER, target: PROVIDER, object: { type: "ServiceContract", contract: "clocked-activity-delivery", offer, capability: cap } };
  return settle(activity, "invoke-service", at, { dataRoot });
}

test("bad incumbent cannot supply an executable or argv in place of an advertised operation", () => {
  const { dataRoot, targetDescriptor } = fixture();
  const bad = { ...targetDescriptor, executable: "/bin/sh", argv: ["-c", "anything"] };
  const { offer } = solicit(bad, dataRoot);
  assert.equal(offer.type, "Question");
  assert.match(offer.object.missing.join(" "), /executable, argv/);
});

test("long-context work may reserve up to one hour but no unbounded delivery", () => {
  const { dataRoot, targetDescriptor } = fixture();
  const solicitTimeout = (timeoutMilliseconds) => {
    const scheduled = { ...request(targetDescriptor), timeoutMilliseconds };
    const source = { "@context": CONTEXT, id: `urn:test:source:${timeoutMilliseconds}`, type: "Create", actor: CUSTOMER, target: PROVIDER, object: { type: "Note", attachment: [scheduled] } };
    const activity = { "@context": CONTEXT, id: `urn:test:solicitation:${timeoutMilliseconds}`, type: "Offer", actor: CUSTOMER, target: PROVIDER, object: { type: "ServiceSolicitation", sourceActivity: source } };
    return settle(activity, "solicit-service", "2026-07-18T23:59:00.000Z", { dataRoot });
  };
  assert.equal(solicitTimeout(3_600_000).type, "Offer");
  const excessive = solicitTimeout(3_600_001);
  assert.equal(excessive.type, "Question");
  assert.match(excessive.object.missing.join(" "), /timeoutMilliseconds/);
});

test("the Cold Red Gate tick bounds the whole publication process tree", () => {
  const unit = readFileSync(new URL("../content/deployments/cold-red-gate/clockkeeper-run-due.service", import.meta.url), "utf8");
  assert.match(unit, /^TimeoutStartSec=70min$/mu);
  assert.match(unit, /^MemoryHigh=55%$/mu);
  assert.match(unit, /^MemoryMax=70%$/mu);
  assert.match(unit, /^MemorySwapMax=0$/mu);
  assert.match(unit, /^OOMPolicy=stop$/mu);
  assert.match(unit, /^Nice=10$/mu);
});

test("a timed-out delivery does not leave its ordinary child running", () => {
  const { dataRoot, target, targetDescriptor } = fixture();
  const hangingTarget = { ...targetDescriptor, operation: "hang", contract: "test/hang/v1" };
  const scheduled = { ...request(hangingTarget), timeoutMilliseconds: 100 };
  const source = { "@context": CONTEXT, id: "urn:test:hang-source", type: "Create", actor: CUSTOMER, target: PROVIDER, object: { type: "Note", attachment: [scheduled] } };
  const solicitation = { "@context": CONTEXT, id: "urn:test:hang-solicitation", type: "Offer", actor: CUSTOMER, target: PROVIDER, object: { type: "ServiceSolicitation", sourceActivity: source } };
  const offer = settle(solicitation, "solicit-service", "2026-07-18T23:59:00.000Z", { dataRoot });
  assert.equal(offer.type, "Offer");
  assert.equal(invoke(offer, dataRoot).type, "Accept");
  const result = runDue("2026-07-19T00:00:00.000Z", { dataRoot });
  assert.equal(result.receipts[0].disposition, "transport-failure");
  assert.equal(result.receipts[0].process.status, 124);
  const pidPath = join(target, "child.pid");
  assert.equal(existsSync(pidPath), true);
  const pid = Number(readFileSync(pidPath, "utf8"));
  try {
    const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2];
    assert.equal(state, "Z", `timed-out child ${pid} remains live in state ${state}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
});

test("accepted schedule authors one provider activity and reserves an occurrence exactly once", () => {
  const { dataRoot, targetDescriptor } = fixture(); const { offer } = solicit(targetDescriptor, dataRoot);
  assert.equal(offer.type, "Offer"); assert.equal(invoke(offer, dataRoot).type, "Accept");
  const seen = [];
  const targetInvoker = (_registration, activity) => { seen.push(activity); return { status: 0, signal: null, stdout: "", stderr: "", response: { type: "Accept", actor: targetDescriptor.actor, object: { type: "Accepted" } }, dryRun: false }; };
  const first = runDue("2026-07-19T00:00:00.000Z", { dataRoot, targetInvoker });
  const replay = runDue("2026-07-19T00:00:30.000Z", { dataRoot, targetInvoker });
  assert.equal(first.attempted, 1); assert.equal(replay.attempted, 0); assert.equal(seen.length, 1);
  assert.equal(seen[0].actor, PROVIDER); assert.equal(seen[0].capability, CAPABILITY); assert.equal(seen[0].target, targetDescriptor.actor);
  assert.equal(first.receipts[0].disposition, "target-accept"); assert.equal(first.receipts[0].retryAuthorized, false);
});

test("live delivery runs an advertised operation from its owning package root", () => {
  const { dataRoot, target, targetDescriptor } = fixture();
  const { offer } = solicit(targetDescriptor, dataRoot);
  assert.equal(invoke(offer, dataRoot).type, "Accept");
  const result = runDue("2026-07-19T00:00:00.000Z", { dataRoot });
  assert.equal(result.receipts[0].disposition, "target-accept");
  assert.equal(result.receipts[0].targetResponse.object.cwd, target);
});

test("a registered schedule refuses a changed imported runtime closure", () => {
  const { dataRoot, target, targetDescriptor } = fixture();
  const { offer } = solicit(targetDescriptor, dataRoot);
  assert.match(offer.object.targetBinding.runtimeDigest, /^sha256:/u);
  assert.ok(offer.object.targetBinding.runtimeFileCount >= 2);
  assert.equal(invoke(offer, dataRoot).type, "Accept");
  writeFileSync(join(target, "dist", "runtime.mjs"), "export const runtimeVersion = 2;\n");
  const result = runDue("2026-07-19T00:00:00.000Z", { dataRoot });
  assert.equal(result.receipts[0].disposition, "transport-failure");
  assert.match(result.receipts[0].process.stderrDigest, /^sha256:/u);
  assert.equal(result.receipts[0].targetResponse, null);
});

test("missed intervals collapse to the current occurrence instead of a catch-up cascade", () => {
  const { dataRoot, targetDescriptor } = fixture(); const { offer } = solicit(targetDescriptor, dataRoot); invoke(offer, dataRoot);
  const targetInvoker = () => ({ status: 0, signal: null, stdout: "", stderr: "", response: { type: "Reject", actor: targetDescriptor.actor, object: { type: "Refusal" } }, dryRun: false });
  const late = runDue("2026-07-19T00:05:00.000Z", { dataRoot, targetInvoker });
  const replay = runDue("2026-07-19T00:05:30.000Z", { dataRoot, targetInvoker });
  assert.equal(late.attempted, 1); assert.equal(late.receipts[0].occurrence, 5); assert.equal(late.receipts[0].disposition, "target-reject");
  assert.equal(replay.attempted, 0); assert.equal(late.receipts[0].retryAuthorized, false); assert.equal(digest(late.receipts[0].activity), late.receipts[0].activityDigest);
});

test("the registered customer can retire one exact schedule without erasing its history", () => {
  const { dataRoot, targetDescriptor } = fixture(); const { offer } = solicit(targetDescriptor, dataRoot); const accepted = invoke(offer, dataRoot);
  assert.equal(accepted.type, "Accept");
  const scheduleId = accepted.object.scheduleId;
  const retirement = {
    "@context": CONTEXT,
    id: "urn:test:retirement",
    type: "Undo",
    actor: CUSTOMER,
    target: PROVIDER,
    object: {
      type: "ScheduleRetirementRequest",
      contract: "clocked-activity-delivery-retirement",
      scheduleId,
      capability: {
        type: "Capability", issuer: CUSTOMER, holder: PROVIDER, invocationTarget: PROVIDER,
        allowedActions: ["retire-schedule"], attenuation: { scheduleId }, singleUse: true,
        expiresAt: "2026-07-19T00:30:00.000Z",
      },
    },
  };
  const result = settle(retirement, "retire-schedule", "2026-07-18T23:59:02.000Z", { dataRoot });
  assert.equal(result.type, "Accept");
  assert.equal(result.object.type, "ScheduleRetirement");
  const due = runDue("2026-07-19T00:00:00.000Z", { dataRoot, targetInvoker: () => assert.fail("retired schedule invoked") });
  assert.equal(due.attempted, 0);
  assert.equal(settle(retirement, "retire-schedule", "2026-07-18T23:59:03.000Z", { dataRoot }).type, "Accept");
});
