// Pure inventory encoding and validation shared with protected consumers.
import { OBSERVED_SCHEMA, assertInventoryBinding, validateObserved, findRawLeaks } from "./writer-census-contract.mjs";

const isFirestore = (name) => name.startsWith("firestore-");
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

// Native JSON parser errors can echo protected file contents, so never propagate the cause.
export function parseProtectedJson(bytes) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("Protected inventory JSON is invalid"); }
}

export function assertSafeObservation(value, binding) {
  assertInventoryBinding(binding);
  const { observed, measurements, surfaces } = value;
  const leaks = [...findRawLeaks(observed, "observed"), ...findRawLeaks(measurements, "measurements"), ...findRawLeaks(surfaces, "surfaces")];
  if (leaks.length) throw new Error(`Inventory output rejected: ${leaks.length} unsafe field paths`);
  const problems = validateObserved(observed, binding);
  if (problems.length) throw new Error(`Inventory shape rejected: ${problems.length} invalid fields`);
}

export function splitForFiles(value, binding) {
  assertSafeObservation(value, binding);
  const { observed, measurements, surfaces } = value;
  const writer = {
    schemaVersion: 2, kind: "netsapiens-writer-inventory", identity: observed.identity, workload: observed.workload, ci: observed.ci, rules: observed.rules,
    surfaces: Object.fromEntries(Object.entries(surfaces).filter(([k]) => !isFirestore(k))),
    measurements: Object.fromEntries(Object.entries(measurements).filter(([k]) => k !== "data")),
  };
  const collection = {
    schemaVersion: 2, kind: "netsapiens-collection-inventory", data: observed.data,
    surfaces: Object.fromEntries(Object.entries(surfaces).filter(([k]) => isFirestore(k))), measurements: { data: measurements.data },
  };
  return { "writer-inventory.json": writer, "collection-inventory.json": collection };
}

export function joinFromFiles(writer, collection, binding) {
  const policy = assertInventoryBinding(binding);
  if (!exact(writer, ["schemaVersion", "kind", "identity", "workload", "ci", "rules", "surfaces", "measurements"]) ||
    !exact(collection, ["schemaVersion", "kind", "data", "surfaces", "measurements"]) ||
    writer.schemaVersion !== 2 || writer.kind !== "netsapiens-writer-inventory" || collection.schemaVersion !== 2 || collection.kind !== "netsapiens-collection-inventory") throw new Error("Invalid inventory file kind");
  if (!writer.surfaces || !collection.surfaces || Object.keys(writer.surfaces).some(isFirestore) || Object.keys(collection.surfaces).some((k) => !isFirestore(k)) || !writer.measurements || !collection.measurements || Object.keys(collection.measurements).join(",") !== "data" || Object.hasOwn(writer.measurements, "data")) throw new Error("Invalid inventory file partition");
  const result = {
    observed: {
      schemaVersion: OBSERVED_SCHEMA, project: policy.project, projectNumber: policy.projectNumber, database: policy.database,
      identity: writer.identity, workload: writer.workload, ci: writer.ci, rules: writer.rules, data: collection.data
    },
    measurements: { ...writer.measurements, ...collection.measurements }, surfaces: { ...writer.surfaces, ...collection.surfaces }
  };
  assertSafeObservation(result, binding);
  return result;
}
