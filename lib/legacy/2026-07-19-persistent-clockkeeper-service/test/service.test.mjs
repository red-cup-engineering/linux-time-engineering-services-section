import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(target, "accept.mjs"), "process.stdout.write(JSON.stringify({type:'Accept',actor:'urn:ame:test-target',object:{type:'Accepted'}}))\n");
  writeFileSync(join(target, "package.json"), JSON.stringify({
    type: "module", bin: { "settle-issue-pulse": "./accept.mjs" },
    "x-agentic-metro-enterprise": { "node-id": "test-target", "operation-catalog": { "settle-issue-pulse": { contract: "test/pulse/v1", timeoutMs: 5000 } } }
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

test("missed intervals collapse to the current occurrence instead of a catch-up cascade", () => {
  const { dataRoot, targetDescriptor } = fixture(); const { offer } = solicit(targetDescriptor, dataRoot); invoke(offer, dataRoot);
  const targetInvoker = () => ({ status: 0, signal: null, stdout: "", stderr: "", response: { type: "Reject", actor: targetDescriptor.actor, object: { type: "Refusal" } }, dryRun: false });
  const late = runDue("2026-07-19T00:05:00.000Z", { dataRoot, targetInvoker });
  const replay = runDue("2026-07-19T00:05:30.000Z", { dataRoot, targetInvoker });
  assert.equal(late.attempted, 1); assert.equal(late.receipts[0].occurrence, 5); assert.equal(late.receipts[0].disposition, "target-reject");
  assert.equal(replay.attempted, 0); assert.equal(late.receipts[0].retryAuthorized, false); assert.equal(digest(late.receipts[0].activity), late.receipts[0].activityDigest);
});
