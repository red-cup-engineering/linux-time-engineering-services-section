#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { semanticBytes, semanticId } from "@emsenn/rmn-semantic-conformance";
import { createSettlementStore, loadSettlementAccount, relationalRwilDocument } from "@emsenn/rwil-rdf-services/client";
import { CONTRACT, RETIREMENT_CONTRACT } from "./law.mjs";

const CONTEXT = "https://www.w3.org/ns/activitystreams";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export { CONTRACT, RETIREMENT_CONTRACT } from "./law.mjs";
// The portable service account is the default provider identity. A colony
// deployment may seat the service under its own already-contracted actor; the
// systemd unit carries that explicit incumbency rather than making it ambient.
export const ACTOR = process.env.CLOCKKEEPER_ACTOR ?? loadSettlementAccount(ROOT).actor;
const EFFECTS = Object.freeze([
  "provider-local-append-only-schedule",
  "provider-local-occurrence-reservation",
  "exact-advertised-target-operation-invocation",
]);
const MAX_TEMPLATE_BYTES = 128 * 1024;
const MAX_DELIVERY_TIMEOUT_MS = 3_600_000;

function canonical(value) { return semanticBytes(relationalRwilDocument(value)); }
export function digest(value) { return semanticId(relationalRwilDocument(value)); }
function id(value) { return digest(value); }
function response(type, source, object) {
  return { "@context": CONTEXT, id: id({ actor: ACTOR, type, inReplyTo: source?.id ?? null, object }), type, actor: ACTOR,
    target: source?.actor ?? "urn:actor:unidentified", inReplyTo: source?.id ?? "urn:activity:unidentified", object };
}
function refusal(source, code, reason) { return response("Reject", source, { type: "Refusal", contract: CONTRACT, code, reason, customerTerritoryMutation: false }); }
function dataRoot(options = {}) { return resolve(options.dataRoot ?? process.env.SCHEDULED_ACTIVITY_DELIVERY_DATA_ROOT ?? join(ROOT, "data")); }
function store(options = {}) { return createSettlementStore({ settlementRoot: ROOT, dataRoot: dataRoot(options), agentUrl: options.agentUrl ?? process.env.RWIL_RDF_AGENT, caip2: options.caip2 }); }
function records(ledger, kind) { return ledger.records(`${CONTRACT}.${kind}`); }
async function append(ledger, kind, value, at) { return ledger.record({ category: `${CONTRACT}.${kind}`, recordedAt: at, record: value }); }
async function witness(ledger, source, outcome, at, details = {}) { return append(ledger, "events", { specversion: "1.0", id: id({ source: source?.id, outcome, at, details }), source: ACTOR, type: `org.emsenn.clockkeeper.${outcome}`, subject: source?.id ?? "urn:activity:unidentified", time: at, datacontenttype: "application/rmn+cbor", data: { contract: CONTRACT, sourceDigest: digest(source ?? null), ...details } }, at); }
function validInstant(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function attachment(activity) { const value = activity?.object?.sourceActivity?.object?.attachment; return (Array.isArray(value) ? value : [value]).find((item) => item?.type === "ScheduledActivityDeliveryRequest"); }
function inside(root, path) { const rel = relative(root, path); return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }

function rawFileDigest(path) { return semanticId(["octets", readFileSync(path)]); }
function runtimeFiles(packageRoot) {
  const admitted = [];
  const visit = (root, prefix) => {
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(root, entry.name); const rel = join(prefix, entry.name).split(sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`runtime binding refuses symlink: ${rel}`);
      if (entry.isDirectory()) visit(path, rel);
      else if (entry.isFile() && (rel.startsWith("dist/") ? rel.endsWith(".mjs") : /\.(?:json|rml|rmn\.cbor)$/u.test(rel))) admitted.push({ path: rel, digest: rawFileDigest(path) });
    }
  };
  visit(join(packageRoot, "dist"), "dist");
  for (const name of ["package.json", "producing-content.config.json", "site-admin.config.json"]) {
    const path = join(packageRoot, name); if (existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) admitted.push({ path: name, digest: rawFileDigest(path) });
  }
  for (const relativeRoot of ["content/contracts", "content/policies", "content/editorial-context"]) visit(join(packageRoot, relativeRoot), relativeRoot);
  return admitted.sort((left, right) => left.path.localeCompare(right.path));
}

function inspectTarget(target) {
  if (!target || !isAbsolute(target.packageRoot ?? "") || typeof target.nodeId !== "string" || typeof target.actor !== "string" || typeof target.operation !== "string" || typeof target.contract !== "string") return { problem: "target must name absolute packageRoot, nodeId, actor, operation, and contract" };
  if (Object.keys(target).some((key) => !["packageRoot", "nodeId", "actor", "operation", "contract"].includes(key))) return { problem: "target may name only its advertised package, actor, operation, and contract; executable, argv, environment, and shell input are forbidden" };
  const packageRoot = resolve(target.packageRoot); const packagePath = join(packageRoot, "package.json");
  if (!existsSync(packagePath) || !lstatSync(packagePath).isFile() || lstatSync(packagePath).isSymbolicLink()) return { problem: "target package.json is not a regular file" };
  let pkg; try { pkg = JSON.parse(readFileSync(packagePath, "utf8")); } catch { return { problem: "target package.json is invalid JSON" }; }
  const catalog = pkg?.["x-agentic-metro-enterprise"]?.["operation-catalog"];
  if (pkg?.["x-agentic-metro-enterprise"]?.["node-id"] !== target.nodeId) return { problem: "target node-id does not match its package advertisement" };
  if (catalog?.[target.operation]?.contract !== target.contract) return { problem: "target operation and contract are not advertised together" };
  const bin = pkg?.bin?.[target.operation];
  if (typeof bin !== "string") return { problem: "target operation has no package bin entry" };
  const entry = resolve(packageRoot, bin);
  if (!inside(packageRoot, entry) || !existsSync(entry) || !lstatSync(entry).isFile() || lstatSync(entry).isSymbolicLink()) return { problem: "advertised target entry is absent, outside its package, or not a regular file" };
  let runtimeEntries; try { runtimeEntries = runtimeFiles(packageRoot); } catch (error) { return { problem: error instanceof Error ? error.message : String(error) }; }
  return { packageRoot, packagePath, packageDigest: digest(readFileSync(packagePath)), entry, entryDigest: digest(readFileSync(entry)), runtimeDigest: digest(runtimeEntries), runtimeFileCount: runtimeEntries.length, advertisedTimeoutMs: catalog[target.operation].timeoutMs ?? null };
}

function inspectRequest(request, at) {
  const problems = [];
  if (request?.type !== "ScheduledActivityDeliveryRequest") problems.push("request type");
  if (!request || !["dry-run", "live"].includes(request.executionMode)) problems.push("executionMode dry-run|live");
  if (!Number.isInteger(request?.schedule?.intervalSeconds) || request.schedule.intervalSeconds < 60 || request.schedule.intervalSeconds > 31_536_000) problems.push("schedule.intervalSeconds 60..31536000");
  if (!validInstant(request?.schedule?.firstDueAt)) problems.push("schedule.firstDueAt");
  if (request?.schedule?.maxDeliveries !== null && (!Number.isInteger(request?.schedule?.maxDeliveries) || request.schedule.maxDeliveries < 1 || request.schedule.maxDeliveries > 10000)) problems.push("schedule.maxDeliveries null|1..10000");
  if (!Number.isInteger(request?.timeoutMilliseconds) || request.timeoutMilliseconds < 1 || request.timeoutMilliseconds > MAX_DELIVERY_TIMEOUT_MS) problems.push(`timeoutMilliseconds 1..${MAX_DELIVERY_TIMEOUT_MS}`);
  if (request?.retry?.maxAttempts !== 1) problems.push("retry.maxAttempts must equal 1");
  if (typeof request?.deliveryCapabilityId !== "string" || !request.deliveryCapabilityId.startsWith("urn:")) problems.push("deliveryCapabilityId");
  if (!request?.activityTemplate || request.activityTemplate["@context"] !== CONTEXT || request.activityTemplate.type !== "Create" || request.activityTemplate.target !== request?.target?.actor || !request.activityTemplate.object || typeof request.activityTemplate.object !== "object") problems.push("finite ActivityStreams Create template addressed to target actor");
  if (request?.activityTemplate && ["id", "actor", "published", "capability"].some((key) => Object.hasOwn(request.activityTemplate, key))) problems.push("template must leave provider-authored envelope fields absent");
  if (canonical(request?.activityTemplate ?? null).byteLength > MAX_TEMPLATE_BYTES) problems.push("activity template byte bound");
  const target = inspectTarget(request?.target);
  if (target.problem) problems.push(target.problem);
  if (!validInstant(at)) problems.push("provider instant");
  return { problems, target };
}

function offerObject(activity, request, target) {
  const requestDigest = digest(request); const scheduleId = id({ provider: ACTOR, customer: activity.actor, requestDigest });
  return { type: "ExecutableServiceOffer", contract: CONTRACT, sourceActivity: activity.object.sourceActivity.id, customer: activity.actor,
    request, requestDigest, scheduleId, targetBinding: { packageDigest: target.packageDigest, entryDigest: target.entryDigest, runtimeDigest: target.runtimeDigest, runtimeFileCount: target.runtimeFileCount, operation: request.target.operation, contract: request.target.contract },
    effects: EFFECTS, operation: "invoke-service", evidence: ["provider-owned-schedule", "one-occurrence-one-attempt-reservation", "exact-target-response-or-transport-failure"],
    nonclaims: ["HTTP-Signature-authentication", "ActivityPub-federation", "customer-work-success", "customer-territory-mutation"] };
}

function sameSet(left, right) { return Array.isArray(left) && left.length === new Set(left).size && left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]); }
function validInvocation(activity, at) {
  const contract = activity?.object; const offer = contract?.offer; const body = offer?.object; const cap = contract?.capability;
  if (activity?.["@context"] !== CONTEXT || activity.type !== "Accept" || activity.target !== ACTOR) return "invocation must be an ActivityStreams Accept addressed to this provider";
  if (contract?.type !== "ServiceContract" || contract.contract !== CONTRACT || offer?.type !== "Offer" || offer.actor !== ACTOR || body?.type !== "ExecutableServiceOffer" || body.contract !== CONTRACT) return "exact provider-authored offer is required";
  if (activity.actor !== body.customer || body.requestDigest !== digest(body.request) || body.scheduleId !== id({ provider: ACTOR, customer: body.customer, requestDigest: body.requestDigest })) return "customer, request, or schedule binding changed";
  const inspected = inspectRequest(body.request, at); if (inspected.problems.length) return `accepted request is no longer admissible: ${inspected.problems.join(", ")}`;
  if (body.targetBinding.packageDigest !== inspected.target.packageDigest || body.targetBinding.entryDigest !== inspected.target.entryDigest || body.targetBinding.runtimeDigest !== inspected.target.runtimeDigest) return "target package, entry, or runtime closure changed after offer";
  if (cap?.type !== "Capability" || cap.issuer !== activity.actor || cap.holder !== ACTOR || cap.invocationTarget !== ACTOR || cap.parentOffer !== offer.id || cap.attenuation?.requestDigest !== body.requestDigest || cap.attenuation?.scheduleId !== body.scheduleId || cap.singleUse !== true || !validInstant(cap.expiresAt) || Date.parse(cap.expiresAt) < Date.parse(at)) return "exact unexpired single-use registration capability is required";
  if (!sameSet(cap.allowedActions, ["invoke-service", ...EFFECTS])) return "registration capability grants inexact effects";
  return null;
}

export async function settle(activity, operation = "solicit-service", at = new Date().toISOString(), options = {}) {
  const ledger = store(options);
  if (operation === "solicit-service") {
    await witness(ledger, activity, "solicitation.received", at);
    if (activity?.["@context"] !== CONTEXT || activity.type !== "Offer" || activity.target !== ACTOR || activity.object?.type !== "ServiceSolicitation") return refusal(activity, "wrong-boundary", "solicitation must be an ActivityStreams Offer<ServiceSolicitation> addressed to this provider");
    const request = attachment(activity); const inspected = inspectRequest(request, at);
    if (inspected.problems.length) return response("Question", activity, { type: "ServiceTermsRequired", contract: CONTRACT, missing: inspected.problems });
    const result = response("Offer", activity, offerObject(activity, request, inspected.target)); await witness(ledger, result, "offer.emitted", at, { scheduleId: result.object.scheduleId, requestDigest: result.object.requestDigest }); return result;
  }
  if (operation === "invoke-service") {
    await witness(ledger, activity, "invocation.received", at); const invalid = validInvocation(activity, at); if (invalid) return refusal(activity, "invalid-contract", invalid);
    const offered = activity.object.offer.object; const prior = records(ledger, "schedules").find((item) => item.scheduleId === offered.scheduleId);
    if (prior) return prior.requestDigest === offered.requestDigest ? response("Accept", activity, prior) : refusal(activity, "conflicting-schedule", "schedule identity was already registered with different bytes");
    const registration = { type: "ScheduleRegistration", id: offered.scheduleId, scheduleId: offered.scheduleId, provider: ACTOR, customer: activity.actor, request: offered.request, requestDigest: offered.requestDigest, targetBinding: offered.targetBinding, acceptedOffer: activity.object.offer.id, registrationCapabilityDigest: digest(activity.object.capability), status: "active", registeredAt: at, customerTerritoryMutation: false };
    await append(ledger, "schedules", registration, at); await witness(ledger, registration, "schedule.registered", at, { scheduleId: registration.scheduleId }); return response("Accept", activity, registration);
  }
  if (operation === "retire-schedule") {
    await witness(ledger, activity, "retirement.received", at);
    const request = activity?.object;
    const scheduleId = request?.scheduleId;
    const registration = records(ledger, "schedules").find((item) => item.scheduleId === scheduleId);
    if (activity?.["@context"] !== CONTEXT || activity.type !== "Undo" || activity.target !== ACTOR || request?.type !== "ScheduleRetirementRequest" || request.contract !== RETIREMENT_CONTRACT || typeof scheduleId !== "string") return refusal(activity, "wrong-retirement-boundary", "retirement must be an ActivityStreams Undo<ScheduleRetirementRequest> addressed to this provider");
    if (!registration) return refusal(activity, "unknown-schedule", "retirement names no provider-owned schedule");
    if (activity.actor !== registration.customer) return refusal(activity, "wrong-customer", "only the registered customer may retire its schedule");
    const cap = request.capability;
    if (cap?.type !== "Capability" || cap.issuer !== activity.actor || cap.holder !== ACTOR || cap.invocationTarget !== ACTOR || cap.attenuation?.scheduleId !== scheduleId || cap.singleUse !== true || !validInstant(cap.expiresAt) || Date.parse(cap.expiresAt) < Date.parse(at) || !sameSet(cap.allowedActions, ["retire-schedule"])) return refusal(activity, "invalid-retirement-capability", "exact unexpired single-use schedule retirement capability is required");
    const requestDigest = digest(activity);
    const prior = records(ledger, "schedule-retirements").find((item) => item.scheduleId === scheduleId);
    if (prior) return prior.requestDigest === requestDigest
      ? response("Accept", activity, prior)
      : refusal(activity, "already-retired", "schedule was already retired by different exact request bytes");
    const retirement = { type: "ScheduleRetirement", id: id({ scheduleId, requestDigest }), scheduleId, provider: ACTOR, customer: activity.actor, contract: RETIREMENT_CONTRACT, requestDigest, registrationDigest: digest(registration), status: "retired", retiredAt: at, customerTerritoryMutation: false };
    await append(ledger, "schedule-retirements", retirement, at); await witness(ledger, retirement, "schedule.retired", at, { scheduleId }); return response("Accept", activity, retirement);
  }
  return refusal(activity, "unknown-operation", `unknown operation ${operation}`);
}

function reservationPath(root, scheduleId, occurrence) { return join(root, "reservations", digest(scheduleId).slice("ni:///sha-256;".length), `${occurrence}.rmn.cbor`); }
function reserve(root, scheduleId, occurrence, at) { const path = reservationPath(root, scheduleId, occurrence); mkdirSync(dirname(path), { recursive: true }); const marker = relationalRwilDocument({ type: "DeliveryOccurrenceReservation", scheduleId, occurrence, reservedAt: at, writeOnce: true }); try { const fd = openSync(path, "wx"); try { writeFileSync(fd, semanticBytes(marker)); } finally { closeSync(fd); } return true; } catch (error) { if (error?.code === "EEXIST") return false; throw error; } }
function deliveredActivity(registration, occurrence, scheduledFor, at) {
  const template = registration.request.activityTemplate;
  const demand = { ...template.object, pulseId: `${registration.scheduleId}#${occurrence}` };
  // ActivityPub only standardizes its public carrier.  A customer's private
  // capability and demand vocabulary belongs inside a typed document; putting
  // unknown terms directly on an Activity causes conforming JSON-LD processors
  // to discard them before the customer can inspect the work order.
  const activityPubDelivery = registration.request.target.contract === "activitypub-services-section/signed-delivery/v1";
  const object = activityPubDelivery
    ? {
        type: "Document",
        mediaType: "application/vnd.emsenn.rmn+json",
        content: JSON.stringify({
          type: "ScheduledActivityWorkOrder",
          capability: registration.request.deliveryCapabilityId,
          demand,
        }),
      }
    : demand;
  const body = {
    "@context": CONTEXT,
    type: template.type,
    actor: ACTOR,
    target: template.target,
    ...(activityPubDelivery ? {} : { capability: registration.request.deliveryCapabilityId }),
    published: at,
    object,
  };
  return { id: id({ scheduleId: registration.scheduleId, occurrence, scheduledFor, body }), ...body };
}
function admittedTargetEnvironment() {
  const names = String(process.env.CLOCKKEEPER_TARGET_ENV_ALLOWLIST ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => /^[A-Z][A-Z0-9_]*$/u.test(name));
  return Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
}
function invokeTarget(registration, activity, options = {}) {
  if (registration.request.executionMode === "dry-run") return { status: 0, signal: null, stdout: "", stderr: "", response: null, dryRun: true };
  if (typeof options.targetInvoker === "function") return options.targetInvoker(registration, activity);
  const inspected = inspectTarget(registration.request.target); if (inspected.problem) return { status: null, signal: null, stdout: "", stderr: inspected.problem, response: null, dryRun: false };
  if (registration.targetBinding?.packageDigest !== inspected.packageDigest || registration.targetBinding?.entryDigest !== inspected.entryDigest || registration.targetBinding?.runtimeDigest !== inspected.runtimeDigest) return { status: null, signal: null, stdout: "", stderr: "target runtime closure changed after schedule registration", response: null, dryRun: false };
  // Own the complete target process tree. Node's spawnSync timeout only
  // terminates its immediate child; a target can launch inference clients or
  // deployment tools which would otherwise survive it and starve the colony.
  // GNU timeout creates and terminates the foreground process group, while
  // nice keeps an admitted long-running issue below interactive recovery work.
  const timeoutExecutable = "/usr/bin/timeout";
  const niceExecutable = "/usr/bin/nice";
  if (!existsSync(timeoutExecutable) || !existsSync(niceExecutable)) return { status: null, signal: null, stdout: "", stderr: "bounded delivery requires /usr/bin/timeout and /usr/bin/nice", response: null, dryRun: false };
  const timeoutSeconds = Math.max(1, Math.ceil(registration.request.timeoutMilliseconds / 1000));
  // Use the timeout option subset shared by GNU coreutils and the uutils
  // coreutils installed on Cold Red Gate. uutils 0.2.2 returns 125 for
  // --kill-after; the service cgroup remains the hard-stop boundary.
  const result = spawnSync(timeoutExecutable, ["--signal=TERM", `${timeoutSeconds}s`, niceExecutable, "-n", "10", process.execPath, inspected.entry], {
    cwd: registration.request.target.packageRoot,
    input: `${JSON.stringify(activity)}\n`,
    encoding: "utf8",
    timeout: registration.request.timeoutMilliseconds + 20_000,
    maxBuffer: 16 * 1024 * 1024,
    // Target resources remain denied by default. A colony deployment may grant
    // named, non-secret service addresses through one explicit allowlist; this
    // makes a scheduled contract capable of hiring its declared providers
    // without leaking the Clockkeeper's ambient process environment.
    env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH, NO_COLOR: "1", ...admittedTargetEnvironment() },
  });
  let parsed = null; try { parsed = JSON.parse(result.stdout); } catch { /* recorded as transport failure */ }
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, response: parsed, dryRun: false };
}

export async function runDue(at = new Date().toISOString(), options = {}) {
  if (!validInstant(at)) throw new Error("run-due requires an explicit valid instant");
  const root = dataRoot(options), ledger = store(options); const receipts = records(ledger, "delivery-receipts"); const retired = new Set(records(ledger, "schedule-retirements").map((item) => item.scheduleId)); const results = [];
  for (const registration of records(ledger, "schedules")) {
    if (registration.status !== "active" || retired.has(registration.scheduleId)) continue;
    const first = Date.parse(registration.request.schedule.firstDueAt); const now = Date.parse(at); if (now < first) continue;
    const occurrence = Math.floor((now - first) / (registration.request.schedule.intervalSeconds * 1000));
    const priorCount = receipts.filter((item) => item.scheduleId === registration.scheduleId).length;
    if (registration.request.schedule.maxDeliveries !== null && priorCount >= registration.request.schedule.maxDeliveries) continue;
    if (receipts.some((item) => item.scheduleId === registration.scheduleId && item.occurrence === occurrence)) continue;
    if (!reserve(root, registration.scheduleId, occurrence, at)) continue;
    const scheduledFor = new Date(first + occurrence * registration.request.schedule.intervalSeconds * 1000).toISOString(); const activity = deliveredActivity(registration, occurrence, scheduledFor, at); const started = Date.now(); const invoked = invokeTarget(registration, activity, options);
    const targetTerminal = invoked.dryRun || (invoked.response && ["Accept", "Reject", "Question"].includes(invoked.response.type));
    const disposition = invoked.dryRun ? "dry-run" : targetTerminal ? `target-${invoked.response.type.toLowerCase()}` : "transport-failure";
    const receipt = { type: "ScheduledDeliveryReceipt", id: id({ scheduleId: registration.scheduleId, occurrence, activity, disposition, response: invoked.response }), scheduleId: registration.scheduleId, occurrence, scheduledFor, attemptedAt: at, activity, activityDigest: digest(activity), disposition, targetResponse: invoked.response, targetResponseDigest: invoked.response ? digest(invoked.response) : null, process: { status: invoked.status, signal: invoked.signal, stderrDigest: digest(invoked.stderr ?? ""), wallTimeMilliseconds: Date.now() - started }, retryAuthorized: false, customerTerritoryMutation: false };
    await append(ledger, "delivery-receipts", receipt, at); await witness(ledger, receipt, "delivery.settled", at, { scheduleId: registration.scheduleId, occurrence, disposition }); results.push(receipt);
  }
  return { type: "ScheduledDeliveryTickResult", actor: ACTOR, at, attempted: results.length, receipts: results, noCatchUpCascade: true };
}

function arg(name, fallback) { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const operation = arg("--operation", "solicit-service"); const at = arg("--now", new Date().toISOString());
  try { const output = operation === "run-due" ? await runDue(at) : await settle(JSON.parse(readFileSync(0, "utf8")), operation, at); process.stdout.write(`${JSON.stringify(output, null, 2)}\n`); if (output.type === "Reject") process.exitCode = 2; }
  catch (error) { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; }
}
