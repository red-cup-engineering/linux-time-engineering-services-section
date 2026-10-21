import { readFileSync } from "node:fs";
import { compileRmlLaw } from "@emsenn/rmn-semantic-conformance/law";

const source = readFileSync(new URL("../content/contracts/clocked-activity-delivery.rml", import.meta.url), "utf8");
const retirementSource = readFileSync(new URL("../content/contracts/clocked-activity-delivery-retirement.rml", import.meta.url), "utf8");
export const CLOCKED_ACTIVITY_DELIVERY_LAW = compileRmlLaw(source);
export const CLOCKED_ACTIVITY_DELIVERY_RETIREMENT_LAW = compileRmlLaw(retirementSource);
export const CLOCKED_ACTIVITY_DELIVERY_LAW_BYTES = CLOCKED_ACTIVITY_DELIVERY_LAW.bytes;
export const CONTRACT = CLOCKED_ACTIVITY_DELIVERY_LAW.id;
export const RETIREMENT_CONTRACT = CLOCKED_ACTIVITY_DELIVERY_RETIREMENT_LAW.id;
