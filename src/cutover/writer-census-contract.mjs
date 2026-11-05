// C1: the shared contract for the writer census and the observer that produces it.
//
// This module is pure: no network and no file IO. The observer, the census
// bootstrap and the comparator all use it, so they cannot disagree about the
// observed schema, principal and condition records, closed permission lists,
// assumption subjects, or the compare rules.
//
// Scope note: W(T) is the writer set. It is over-approximated, and a deny policy
// never subtracts from it.
import { createHash } from "node:crypto";
import { canonicalJson } from "./dsse-verifier-core.mjs";

export const CENSUS_SCHEMA = 2;
export const OBSERVED_SCHEMA = 2;
export const PROJECT = "phoneware-edge";
export const PROJECT_NUMBER = "859122914438";
export const DATABASE = "(default)";
export const PRODUCTION_INVENTORY_BINDING = Object.freeze({ profile: "production", project: PROJECT, projectNumber: PROJECT_NUMBER, database: DATABASE });
export const EMULATOR_INVENTORY_BINDING = Object.freeze({ profile: "emulator", project: "demo-netsapiens-cutover", projectNumber: null, database: "(default)" });
export function assertInventoryBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
    JSON.stringify(Object.keys(binding).sort()) !== JSON.stringify(["database", "profile", "project", "projectNumber"])) throw new Error("Invalid inventory binding");
  const expected = binding.profile === "production" ? PRODUCTION_INVENTORY_BINDING : binding.profile === "emulator" ? EMULATOR_INVENTORY_BINDING : null;
  if (!expected || Object.keys(expected).some((key) => binding[key] !== expected[key])) throw new Error("Invalid inventory binding");
  return expected;
}
export const NAMESPACE_PATTERN = /^(mcp_|pwmcp_|readonly_mcp_)|^operations$/;

export const DEFAULT_BOUNDS = Object.freeze({ namespaceMaxDocuments: 2_000_000, fullPassMaxDocuments: 2_000_000, maxServiceAccounts: 500 });

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------------------
// 2.2 Closed lists. A role is classified by its permissions, never by name.
// ---------------------------------------------------------------------------
export const WRITE_PERMISSION_PATTERNS = Object.freeze([
  /^datastore\.(entities|databases|indexes|fields|backups)\.(create|update|delete)$/,
  /^datastore\.databases\.(import|bulkDelete)$/,
  /^firebaserules\.(releases|rulesets)\.(create|update|delete)$/,
  /^firebase\.[A-Za-z.]+\.(create|update|delete)$/,
]);
export const CONTROL_PERMISSION_PATTERNS = Object.freeze([
  /^iam\.serviceAccounts\.(actAs|getAccessToken|getOpenIdToken|getIdToken|signBlob|signJwt|implicitDelegation|setIamPolicy|create|delete|update|enable|undelete)$/,
  /^iam\.serviceAccountKeys\.(create|enable)$/,
  /^iam\.(roles|workloadIdentityPools|workloadIdentityPoolProviders)\.(create|update|delete|undelete|setIamPolicy)$/,
  /^resourcemanager\.(projects|folders|organizations)\.setIamPolicy$/,
  /^(run\.(services|jobs)|cloudfunctions\.functions|compute\.instances)\.(create|update|setIamPolicy)$/,
  /^run\.jobs\.(run|runWithOverrides)$/,
  /^compute\.instances\.(setMetadata|setServiceAccount)$/,
  /^compute\.projects\.setCommonInstanceMetadata$/,
  /^cloudbuild\.builds\.create$/,
  /^artifactregistry\.(repositories\.uploadArtifacts|tags\.(create|update))$/,
  /^appengine\.versions\.(create|update)$/,
  /^workflows\.workflows\.(create|update)$/,
  /^container\.pods\.(create|exec)$/,
]);
export const IMPERSONATION_PERMISSIONS = Object.freeze([
  "iam.serviceAccounts.getAccessToken", "iam.serviceAccounts.getOpenIdToken", "iam.serviceAccounts.signBlob",
  "iam.serviceAccounts.signJwt", "iam.serviceAccounts.implicitDelegation", "iam.serviceAccounts.actAs",
  "iam.serviceAccounts.setIamPolicy", "iam.serviceAccountKeys.create",
]);
export const BASIC_ROLES = Object.freeze({
  "roles/owner": Object.freeze({ writer: true, controller: true, impersonation: true }),
  "roles/editor": Object.freeze({ writer: true, controller: true, impersonation: true }),
  "roles/viewer": Object.freeze({ writer: false, controller: false, impersonation: false }),
});

// Google-managed service agents. They are recorded with agent: true.
export const SERVICE_AGENT_PATTERNS = Object.freeze([
  /^service-\d+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/,
  /@gcp-sa-[a-z0-9-]+\.iam\.gserviceaccount\.com$/,
  /^\d+@cloudservices\.gserviceaccount\.com$/,
  /@firebase-sa-management\.iam\.gserviceaccount\.com$/,
]);
// Emails allowed in observed output. Anything else is a leak.
export const MACHINE_EMAIL_PATTERN = /@([a-z0-9-]+\.iam|developer|appspot|cloudbuild|cloudservices)\.gserviceaccount\.com$/;
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TOKEN_IN_TEXT = /ya29\.[A-Za-z0-9._-]+|Bearer\s+\S+/;

export const CONDITIONAL_SURFACES = Object.freeze({
  "run-services": "run.googleapis.com",
  "run-revisions": "run.googleapis.com",
  "run-jobs": "run.googleapis.com",
  "cloud-functions": "cloudfunctions.googleapis.com",
  "compute-instances": "compute.googleapis.com",
  "app-engine": "appengine.googleapis.com",
  "workflows": "workflows.googleapis.com",
  "cloud-build-triggers": "cloudbuild.googleapis.com",
});
// An enabled API mapped to null must have zero resources.
export const COMPUTE_CAPABLE_APIS = Object.freeze({
  "run.googleapis.com": ["run-services", "run-revisions", "run-jobs"],
  "cloudfunctions.googleapis.com": ["cloud-functions"],
  "compute.googleapis.com": ["compute-instances"],
  "appengine.googleapis.com": ["app-engine"],
  "workflows.googleapis.com": ["workflows"],
  "cloudbuild.googleapis.com": ["cloud-build-triggers"],
  "container.googleapis.com": null,
  "batch.googleapis.com": null,
  "dataflow.googleapis.com": null,
  "composer.googleapis.com": null,
  "dataproc.googleapis.com": null,
  "aiplatform.googleapis.com": null,
  "cloudscheduler.googleapis.com": null,
  "cloudtasks.googleapis.com": null,
  "notebooks.googleapis.com": null,
});

export const SURFACES = Object.freeze([
  "iam-ancestry", "iam-project-policy", "iam-ancestor-policies", "iam-role-definitions", "service-accounts",
  "service-account-iam-policies", "service-account-keys",
  "enabled-services", "run-services", "run-revisions", "run-jobs", "cloud-functions", "compute-instances",
  "app-engine", "workflows", "cloud-build-triggers", "unsupported-compute", "image-attribution",
  "wif-pools", "wif-providers", "ci-admitted-state",
  "firestore-top-level", "firestore-namespace-walk", "firestore-full-pass", "firestore-ttl-fields",
  "firebase-rules-releases", "firebase-rulesets", "firebase-rules-tests",
]);

// ---------------------------------------------------------------------------
// 2.3 Principal and condition records
// ---------------------------------------------------------------------------
const lower = (text) => text.toLowerCase();
const humanSha = (type, email) => sha256(`principal:${type}:${lower(email)}`);

export function principalRecord(rawMember) {
  if (typeof rawMember !== "string" || !rawMember) throw new Error("principal must be a non-empty string");
  let member = rawMember;
  let deleted = false;
  if (member.startsWith("deleted:")) {
    deleted = true;
    member = member.slice("deleted:".length);
  }
  member = member.replace(/\?uid=[^?]*$/, "");

  const colon = member.indexOf(":");
  const prefix = colon > 0 ? member.slice(0, colon + 1) : "";
  const value = colon > 0 ? member.slice(colon + 1) : "";
  if (member.startsWith("principal://") || member.startsWith("principalSet://")) {
    if (member.includes("/locations/global/workforcePools/")) {
      return { kind: "human", type: "workforce", domain: null, sha256: sha256(`principal:workforce:${lower(member)}`), deleted };
    }
    if (member.includes("/workloadIdentityPools/")) return { kind: "workload", member };
    throw new Error("unknown principal:// scope");
  }
  if (member === "allUsers" || member === "allAuthenticatedUsers") return { kind: "public", member };
  if (["projectOwner:", "projectEditor:", "projectViewer:"].includes(prefix)) return { kind: "convenience", member };
  if (prefix === "user:" || prefix === "group:") {
    const at = value.lastIndexOf("@");
    if (at < 0) throw new Error("human principal without a domain");
    const domain = lower(value.slice(at + 1));
    return { kind: "human", type: prefix.slice(0, -1), domain, sha256: humanSha(prefix.slice(0, -1), value), deleted };
  }
  if (prefix === "domain:") {
    return { kind: "human", type: "domain", domain: lower(value), sha256: sha256(`principal:domain:${lower(value)}`), deleted };
  }
  if (prefix === "serviceAccount:") {
    return { kind: "serviceAccount", email: lower(value), agent: SERVICE_AGENT_PATTERNS.some((re) => re.test(lower(value))), deleted };
  }
  throw new Error("unknown principal prefix");
}

export function conditionRecord(condition) {
  if (condition === null || condition === undefined) return null;
  if (typeof condition.title !== "string" || typeof condition.expression !== "string") throw new Error("malformed condition");
  return { title: condition.title, expression: condition.expression, expressionSha256: sha256(condition.expression) };
}

// ---------------------------------------------------------------------------
// 2.2 Role classification
// ---------------------------------------------------------------------------
export function classifyRole(roleId, permissions) {
  if (Object.hasOwn(BASIC_ROLES, roleId)) {
    return { ...BASIC_ROLES[roleId], matched: [roleId], definition: "basic" };
  }
  if (permissions === null || permissions === undefined) {
    return { writer: true, controller: true, impersonation: true, matched: ["*unreadable*"], definition: "unreadable" };
  }
  if (!Array.isArray(permissions) || permissions.some((p) => typeof p !== "string")) throw new Error("malformed permission list");
  const writer = permissions.some((p) => WRITE_PERMISSION_PATTERNS.some((re) => re.test(p)));
  const controller = permissions.some((p) => CONTROL_PERMISSION_PATTERNS.some((re) => re.test(p)));
  const impersonation = permissions.some((p) => IMPERSONATION_PERMISSIONS.includes(p));
  const matched = [...new Set(permissions.filter((p) =>
    WRITE_PERMISSION_PATTERNS.some((re) => re.test(p)) || CONTROL_PERMISSION_PATTERNS.some((re) => re.test(p)) || IMPERSONATION_PERMISSIONS.includes(p)))].sort();
  return { writer, controller, impersonation, matched, definition: "read" };
}

export function closedListsDigest() {
  return sha256(canonicalJson({
    write: WRITE_PERMISSION_PATTERNS.map((p) => p.source),
    control: CONTROL_PERMISSION_PATTERNS.map((p) => p.source),
    impersonation: [...IMPERSONATION_PERMISSIONS].sort(),
    basic: Object.fromEntries(Object.entries(BASIC_ROLES).map(([id, v]) => [id, { writer: v.writer, controller: v.controller, impersonation: v.impersonation }])),
    serviceAgents: SERVICE_AGENT_PATTERNS.map((p) => p.source),
    machineEmail: MACHINE_EMAIL_PATTERN.source,
    computeCapable: COMPUTE_CAPABLE_APIS,
    namespace: NAMESPACE_PATTERN.source,
    conditional: CONDITIONAL_SURFACES,
    surfaces: [...SURFACES],
    inventoryBindings: [PRODUCTION_INVENTORY_BINDING, EMULATOR_INVENTORY_BINDING],
  }));
}

// ---------------------------------------------------------------------------
// W(T): the writer set. A service account is in W(T) when a writer or controller
// principal is that account, or can reach it through impersonation.
// ---------------------------------------------------------------------------
export function computeWriterSet(identity) {
  // E3: W(T) is exactly the service-account principals that are writers or controllers.
  // Via targets are not added: an impersonator gains the target's powers, not the reverse.
  const set = new Set();
  for (const entry of identity?.principals ?? []) {
    if ((entry.writer || entry.controller) && entry.principal.kind === "serviceAccount") set.add(entry.principal.email);
  }
  return set;
}

// ---------------------------------------------------------------------------
// 2.4 Observed schema
// ---------------------------------------------------------------------------
const isStr = (v) => typeof v === "string" && v.length > 0;
const isBool = (v) => typeof v === "boolean";
const isInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isHex40 = (v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
const isHex64 = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isDigest = (v) => typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v);
const isAnyStr = (v) => typeof v === "string";
const isServiceAccountEmail = (v) => typeof v === "string" && /^[a-z0-9][a-z0-9._%+-]*@[a-z0-9.-]+\.gserviceaccount\.com$/.test(v);

const PRINCIPAL = {
  oneOf: [
    { obj: { kind: { literal: "human" }, type: { enumOf: ["user", "group", "domain", "workforce"] }, domain: { nullable: isAnyStr }, sha256: isHex64, deleted: isBool } },
    { obj: { kind: { literal: "serviceAccount" }, email: isStr, agent: isBool, deleted: isBool } },
    { obj: { kind: { literal: "workload" }, member: isStr } },
    { obj: { kind: { literal: "public" }, member: { enumOf: ["allUsers", "allAuthenticatedUsers"] } } },
    { obj: { kind: { literal: "convenience" }, member: isStr } },
  ]
};
const CONDITION = { nullable: { obj: { title: isAnyStr, expression: isAnyStr, expressionSha256: isHex64 } } };

const OBSERVED_SPEC = {
  obj: {
    schemaVersion: { literal: OBSERVED_SCHEMA },
    project: { literal: PROJECT },
    projectNumber: { literal: PROJECT_NUMBER },
    database: { literal: DATABASE },
    identity: {
      obj: {
        ancestry: { arr: isStr },
        policies: { arr: { obj: { resource: isStr, read: isBool } } },
        roles: { arr: { obj: { role: isStr, definition: { enumOf: ["read", "basic", "unreadable"] }, writer: isBool, controller: isBool, impersonation: isBool, matched: { arr: isStr } } } },
        grants: { arr: { obj: { resource: isStr, role: isStr, principal: PRINCIPAL, condition: CONDITION } } },
        principals: { arr: { obj: { principal: PRINCIPAL, writer: isBool, controller: isBool, via: { arr: isStr } } } },
        serviceAccounts: {
          arr: {
            obj: {
              email: isStr, projectOwned: isBool, agent: isBool, disabled: { nullable: isBool }, policyRead: isBool, keysRead: isBool,
              keys: { arr: { obj: { keyId: isStr, disabled: isBool, validAfterTime: isStr, validBeforeTime: { nullable: isStr }, keyOrigin: isStr } } },
            }
          }
        },
      }
    },
    workload: {
      obj: {
        enabledServices: { arr: isStr },
        workloads: {
          arr: {
            obj: {
              kind: { enumOf: ["run-revision", "run-job", "function", "compute-instance", "app-engine-version", "workflow"] },
              location: isStr, name: isStr, parent: { nullable: isStr },
              serving: { nullable: { obj: { percent: isInt, tags: { arr: isStr }, latestReady: isBool } } },
              serviceAccount: isServiceAccountEmail,
              environment: { nullable: { enumOf: ["GEN_1", "GEN_2"] } },
              images: { arr: { obj: { container: isStr, repository: isStr, digest: { nullable: isDigest }, digestSource: { enumOf: ["revision-status", "pinned", "registry-tag", "none"] } } } },
            }
          }
        },
        attribution: { arr: { obj: { digest: isDigest, repository: isStr, method: { enumOf: ["cloud-build", "ar-tag", "unmapped"] }, sourceRepository: { nullable: isStr }, commit: { nullable: isHex40 } } } },
      }
    },
    ci: {
      obj: {
        wifPools: { arr: { obj: { pool: isStr, state: isStr, disabled: isBool } } },
        wifProviders: {
          arr: {
            obj: {
              pool: isStr, provider: isStr, state: isStr, disabled: isBool, issuer: { nullable: isStr },
              allowedAudiences: { arr: isStr }, attributeMapping: { map: isAnyStr },
              attributeCondition: { nullable: isAnyStr }, attributeConditionSha256: { nullable: isHex64 },
              admitted: { nullable: { arr: { obj: { repository: isStr, workflowPath: isStr, ref: isStr } } } },
            }
          }
        },
        admittedState: { arr: { obj: { repository: isStr, ref: isStr, readable: isBool, headCommit: { nullable: isHex40 }, workflows: { arr: { obj: { path: isStr, blobSha: isHex40 } } } } } },
        buildTriggers: { arr: { obj: { location: isStr, name: isStr, serviceAccount: isServiceAccountEmail, disabled: isBool, source: isAnyStr, filter: isAnyStr, configSha256: { nullable: isHex64 } } } },
      }
    },
    data: {
      obj: {
        topLevel: { obj: { namespace: { arr: isStr } } },
        namespacePatterns: { arr: isStr },
        fullPass: { obj: { complete: isBool } },
        foreignParentPrefixed: { arr: isStr },
        sharedGroupIds: { arr: isStr },
        ttlFields: { arr: { obj: { collectionGroup: isStr, field: isStr } } },
      }
    },
    rules: {
      obj: {
        releases: { arr: { obj: { release: isStr, ruleset: isStr, files: { arr: { obj: { name: isStr, sha256: isHex64 } } } } } },
        matchesCommitted: isBool,
        reachability: { enumOf: ["none", "reachable", "unresolved"] },
        tests: { arr: { obj: { group: isStr, auth: { enumOf: ["none", "synthetic"] }, method: { literal: "create" }, result: { enumOf: ["deny", "allow"] } } } },
      }
    },
  },
};

// Shape checks. Each problem names a path only, never a value.
export function validateShape(value, spec, at = "observed") {
  const problems = [];
  const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
  const visit = (v, s, p) => {
    if (typeof s === "function") { if (!s(v)) problems.push({ at: p, kind: "shape" }); return; }
    if ("literal" in s) { if (v !== s.literal) problems.push({ at: p, kind: "shape" }); return; }
    if ("enumOf" in s) { if (!s.enumOf.includes(v)) problems.push({ at: p, kind: "shape" }); return; }
    if ("nullable" in s) { if (v !== null) visit(v, s.nullable, p); return; }
    if ("arr" in s) {
      if (!Array.isArray(v)) { problems.push({ at: p, kind: "shape" }); return; }
      v.forEach((item, i) => visit(item, s.arr, `${p}[${i}]`));
      return;
    }
    if ("map" in s) {
      if (!plain(v)) { problems.push({ at: p, kind: "shape" }); return; }
      for (const [k, child] of Object.entries(v)) visit(child, s.map, `${p}.${k}`);
      return;
    }
    if ("any" in s) return;
    if ("oneOf" in s) {
      const ok = s.oneOf.some((option) => validateShape(v, option, p).length === 0);
      if (!ok) problems.push({ at: p, kind: "shape" });
      return;
    }
    if ("obj" in s) {
      if (!plain(v)) { problems.push({ at: p, kind: "shape" }); return; }
      const expected = Object.keys(s.obj).sort();
      const actual = Object.keys(v).sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) problems.push({ at: p, kind: "keys", missing: expected.filter((k) => !actual.includes(k)), extra: actual.filter((k) => !expected.includes(k)) });
      for (const key of expected) if (Object.hasOwn(v, key)) visit(v[key], s.obj[key], `${p}.${key}`);
      return;
    }
    throw new Error("unknown schema node");
  };
  visit(value, spec, at);
  return problems;
}

// Ordering has one owner (E9). Positional arrays keep their order. serviceAccounts is sorted by email. Every other
// array is sorted by canonical JSON. canonicalizeObserved produces exactly that order, and checkSorted enforces it.
const POSITIONAL = new Set(["ancestry", "policies"]);
const BY_EMAIL = new Set(["serviceAccounts"]);
function checkSorted(value, path, problems) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkSorted(item, `${path}[${i}]`, problems));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (Array.isArray(child) && !POSITIONAL.has(key)) {
        if (BY_EMAIL.has(key)) {
          const emails = child.map((item) => item.email);
          if (JSON.stringify(emails) !== JSON.stringify([...emails].sort())) problems.push({ at: `${path}.${key}`, kind: "unsorted-email" });
        } else {
          const keys = child.map((item) => canonicalJson(item));
          if (JSON.stringify(keys) !== JSON.stringify([...keys].sort())) problems.push({ at: `${path}.${key}`, kind: "unsorted" });
        }
      }
      checkSorted(child, `${path}.${key}`, problems);
    }
  }
}

// E9: readers emit any order. The observer and R7 call this before validateObserved or compareCensus.
export function canonicalizeObserved(value, key = null) {
  if (Array.isArray(value)) {
    if (POSITIONAL.has(key)) return value.map((item) => canonicalizeObserved(item));
    if (BY_EMAIL.has(key)) {
      return value.map((item) => canonicalizeObserved(item)).sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
    }
    return value
      .map((item) => canonicalizeObserved(item))
      .map((item) => ({ item, text: canonicalJson(item) }))
      .sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
      .map(({ item }) => item);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, child]) => [k, canonicalizeObserved(child, k)]));
  }
  return value;
}

// Pattern rule (see note on positions below): collection positions are the even
// 0-based indexes and document positions the odd ones, so every odd index must be "*".
export function patternProblems(pattern) {
  const parts = pattern.split("/");
  if (parts.length % 2 === 0) return ["even-segment-count"];
  const problems = [];
  parts.forEach((segment, i) => {
    if (i % 2 === 1 && segment !== "*") problems.push("document-position-not-wildcard");
    if (i % 2 === 0 && segment === "*") problems.push("collection-position-wildcard");
  });
  return problems;
}

export function validateObserved(observed, binding) {
  const policy = assertInventoryBinding(binding);
  const spec = { obj: { ...OBSERVED_SPEC.obj, project: { literal: policy.project }, projectNumber: { literal: policy.projectNumber }, database: { literal: policy.database } } };
  const problems = validateShape(observed, spec);
  if (problems.length) return problems;
  checkSorted(observed, "observed", problems);
  for (const pattern of [...observed.data.namespacePatterns, ...observed.data.foreignParentPrefixed]) {
    for (const kind of patternProblems(pattern)) problems.push({ at: `data.pattern:${pattern}`, kind });
  }
  // E6: values and keys are scanned for principal prefixes, tokens and non-machine emails.
  const leaks = findRawLeaks(observed, "observed");
  if (leaks.length) problems.push({ at: "observed", kind: "raw-leak", paths: leaks });
  // E3: every via string has one of the two permitted shapes, and impersonation targets are in W(T).
  const machineEmail = "[a-z0-9._%+-]+@(?:[a-z0-9-]+\\.iam|developer|appspot|cloudbuild|cloudservices)\\.gserviceaccount\\.com";
  const VIA_DIRECT = new RegExp(`^direct:((projects|folders|organizations)/[0-9]+|serviceAccounts/${machineEmail})$`);
  const VIA_IMPERSONATION = new RegExp(`^impersonation:${machineEmail}$`);
  const writerSet = computeWriterSet(observed.identity);
  for (const p of observed.identity.principals) {
    for (const via of p.via) {
      if (!VIA_DIRECT.test(via) && !VIA_IMPERSONATION.test(via)) problems.push({ at: "identity.principals.via", kind: "via-pattern" });
      if (via.startsWith("impersonation:") && !writerSet.has(via.slice("impersonation:".length))) problems.push({ at: "identity.principals.via", kind: "via-target-not-in-writer-set" });
    }
  }
  // E5: a cloud-build or ar-tag attribution carries a repository and a commit; unmapped carries neither.
  for (const a of observed.workload.attribution) {
    if (a.method === "unmapped") {
      if (a.sourceRepository !== null || a.commit !== null) problems.push({ at: "workload.attribution", kind: "unmapped-with-source" });
    } else if (!a.sourceRepository || !a.commit) {
      problems.push({ at: "workload.attribution", kind: "attribution-missing-source" });
    }
  }
  for (const entry of observed.identity.principals) {
    if (!entry.writer && !entry.controller) problems.push({ at: "identity.principals", kind: "not-writer-or-controller" });
  }
  const writers = [...computeWriterSet(observed.identity)].sort();
  const accounts = observed.identity.serviceAccounts.map((sa) => sa.email);
  if (JSON.stringify(writers) !== JSON.stringify(accounts)) problems.push({ at: "identity.serviceAccounts", kind: "not-writer-set" });
  return problems;
}

// ---------------------------------------------------------------------------
// Leak scan. Applies to observed, measurements and surface errors.
// ---------------------------------------------------------------------------
export function findRawLeaks(value, path = "$") {
  // E6: a string is scanned as a value and as an object key. A documentCounts key must pass the
  // document-position pattern rule, so a real document path cannot hide in a count.
  const leaks = [];
  const scanText = (text, at) => {
    if (/^(deleted:)?(user|group|domain):/.test(text)) leaks.push(at);
    if (TOKEN_IN_TEXT.test(text)) leaks.push(at);
    for (const match of text.match(EMAIL_IN_TEXT) ?? []) if (!MACHINE_EMAIL_PATTERN.test(match)) leaks.push(at);
  };
  const walk = (node, at) => {
    if (typeof node === "string") { scanText(node, at); return; }
    if (Array.isArray(node)) { node.forEach((child, i) => walk(child, `${at}[${i}]`)); return; }
    if (node && typeof node === "object") {
      const patternKeys = new Set(["namespacePatterns", "foreignParentPrefixed"]);
      for (const [key, child] of Object.entries(node)) {
        scanText(key, `${at}.<key>`);
        if (patternKeys.has(key) && Array.isArray(child)) {
          for (const pattern of child) if (typeof pattern === "string" && patternProblems(pattern).length) leaks.push(`${at}.${key}`);
        }
        if (key === "documentCounts" && child && typeof child === "object") {
          for (const docKey of Object.keys(child)) if (patternProblems(docKey).length) leaks.push(`${at}.${key}.<key>`);
        }
        walk(child, `${at}.${key}`);
      }
    }
  };
  walk(value, path);
  return [...new Set(leaks)].sort();
}

// ---------------------------------------------------------------------------
// 2.6 Assumption catalog. Each assumption carries subjects and is emitted only
// while its gap is open. Subjects are sorted strings.
// ---------------------------------------------------------------------------
export const ASSUMPTION_IDS = Object.freeze([
  "human-principals", "org-folder-allow-unobserved", "service-account-unobserved", "user-managed-key",
  "google-managed", "image-tag-attribution", "unattributable-workload", "ci-plane-unreadable", "ci-unbounded",
  "client-writes", "rules-not-committed", "foreign-parent-subtrees", "dynamic-name", "post-observation-window",
]);

export function emittedAssumptions(observed, census) {
  const out = new Map();
  const add = (id, subjects) => {
    const unique = [...new Set(subjects)].sort();
    if (unique.length) out.set(id, unique);
  };
  const writers = computeWriterSet(observed.identity);
  const wt = observed.identity.principals.filter((p) => p.writer || p.controller);

  add("human-principals", wt.flatMap((p) => {
    if (p.principal.kind === "human") return [`human:${p.principal.sha256}`];
    if (p.principal.kind === "convenience") return [`convenience:${p.principal.member}`];
    return [];
  }));
  add("org-folder-allow-unobserved", observed.identity.policies.filter((p) => !p.read).map((p) => p.resource));
  add("service-account-unobserved", observed.identity.serviceAccounts.filter((sa) => !sa.policyRead || !sa.keysRead).map((sa) => sa.email));
  // E4: every recorded key on a W service account, disabled keys included, with no keyOrigin filter.
  add("user-managed-key", observed.identity.serviceAccounts.filter((sa) => writers.has(sa.email))
    .flatMap((sa) => sa.keys.map((k) => `${sa.email}/${k.keyId}`)));
  add("google-managed", [
    ...wt.filter((p) => p.principal.kind === "serviceAccount" && p.principal.agent).map((p) => p.principal.email),
    ...observed.data.ttlFields.map((t) => `ttl:${t.collectionGroup}/${t.field}`),
  ]);
  const attribution = new Map(observed.workload.attribution.map((a) => [a.digest, a]));
  const wtWorkloads = observed.workload.workloads.filter((w) => writers.has(w.serviceAccount));
  add("image-tag-attribution", wtWorkloads.flatMap((w) => w.images.map((i) => i.digest).filter(Boolean))
    .filter((d) => attribution.get(d)?.method === "ar-tag"));
  add("unattributable-workload", [
    ...wtWorkloads.filter((w) => w.images.length === 0 || w.images.some((i) => !i.digest || attribution.get(i.digest)?.method === "unmapped")
      || (w.kind === "function" && w.environment === "GEN_1"))
      .map((w) => `${w.kind}/${w.location}/${w.name}`),
    ...observed.ci.buildTriggers.filter((t) => !t.disabled && writers.has(t.serviceAccount)).map((t) => `cloud-build-trigger/${t.location}/${t.name}`),
  ]);
  add("ci-plane-unreadable", observed.ci.admittedState.filter((a) => !a.readable).map((a) => a.repository));
  add("ci-unbounded", observed.ci.wifProviders.flatMap((p) => (p.admitted ?? []).filter((a) => a.ref === "*")
    .map((a) => `${p.pool}/${p.provider}:${a.repository}`)));
  // E18: client-writes only for a reachable candidate or an allow probe. Unresolved reachability is not accepted here:
  // the reader fails firebase-rules-tests, so the compare fails on the surface.
  add("client-writes", observed.rules.reachability === "reachable" || observed.rules.tests.some((t) => t.result === "allow")
    ? observed.rules.releases.map((r) => r.release) : []);
  add("rules-not-committed", observed.rules.matchesCommitted ? [] : observed.rules.releases.map((r) => r.release));
  add("foreign-parent-subtrees", observed.data.fullPass.complete ? [] : [DATABASE]);
  const dynamic = (census?.codeCensus ?? []).flatMap((repo) => repo.writeSites
    .filter((s) => s.dynamic && s.dynamic.resolved === false)
    .map((s) => `${repo.repository}@${repo.commit}:${s.file}:${s.line}`));
  add("dynamic-name", dynamic);
  add("post-observation-window", census?.mode?.runnerAuditReread === false ? ["runner"] : []);

  return [...out.entries()].map(([id, subjects]) => ({ id, subjects })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// 2.7 Census schema and compare
// ---------------------------------------------------------------------------
const ROLES = ["migration", "meta", "operations", "runtime", "governance"];
const FENCES = ["runner", "guard", "none"];
const CENSUS_SPEC = {
  obj: {
    schemaVersion: { literal: CENSUS_SCHEMA },
    kind: { literal: "netsapiens-writer-census" },
    closedListsSha256: isHex64,
    bounds: { obj: { namespaceMaxDocuments: isInt, fullPassMaxDocuments: isInt, maxServiceAccounts: isInt } },
    mode: { obj: { runnerAuditReread: isBool } },
    union: { arr: isStr },
    exclusions: { arr: { obj: { pattern: isStr, reason: isStr } } },
    codeCensus: {
      arr: {
        obj: {
          repository: isStr, commit: isHex40,
          writeSites: {
            arr: {
              obj: {
                file: isStr, line: isInt, group: { nullable: isStr }, role: { enumOf: ROLES }, fence: { enumOf: FENCES },
                dynamic: { nullable: { obj: { source: isStr, resolved: isBool, value: { nullable: isStr } } } },
              }
            }
          },
        }
      }
    },
    acceptedAssumptions: { arr: { obj: { id: { enumOf: [...ASSUMPTION_IDS] }, subjects: { arr: isStr } } } },
    observed: { any: true },
    review: { obj: { reviewedBy: isStr, reviewedAt: isStr, instructionRef: isStr } },
  },
};

export function validateCensus(census, binding) {
  assertInventoryBinding(binding);
  const problems = validateShape(census, CENSUS_SPEC, "census");
  if (problems.length) return problems;
  if (census.closedListsSha256 !== closedListsDigest()) problems.push({ at: "census.closedListsSha256", kind: "closed-lists-changed" });
  if (!isSortedUnique(census.union)) problems.push({ at: "census.union", kind: "unsorted" });
  for (const [key, value] of Object.entries(census.bounds)) if (!Number.isSafeInteger(value) || value <= 0) problems.push({ at: `census.bounds.${key}`, kind: "bound" });
  for (const a of census.acceptedAssumptions) if (!isSortedUnique(a.subjects)) problems.push({ at: "census.acceptedAssumptions", kind: "unsorted" });
  return problems;
}

function isSortedUnique(list) {
  return JSON.stringify(list) === JSON.stringify([...new Set(list)].sort());
}

function normalizeAssumptions(list) {
  return list.map((a) => ({ id: a.id, subjects: [...new Set(a.subjects)].sort() })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function surfaceProblems(surfaces, observed) {
  const problems = [];
  const incomplete = [];
  for (const name of SURFACES) {
    const entry = surfaces?.[name];
    if (!entry) { incomplete.push(name); continue; }
    if (entry.status === "ok") continue;
    if (entry.status === "absent" && Object.hasOwn(CONDITIONAL_SURFACES, name)) {
      const api = CONDITIONAL_SURFACES[name];
      const enabled = observed?.workload?.enabledServices?.includes(api);
      const appEngine404 = name === "app-engine" && entry.reason === "404";
      if (appEngine404 || !enabled) continue;
    }
    incomplete.push(name);
  }
  if (incomplete.length) problems.push({ kind: "incomplete-surfaces", surfaces: incomplete });
  return problems;
}

function dataProblems(observed, census) {
  const problems = [];
  const union = new Set(census.union);
  const exclusionPatterns = new Set(census.exclusions.map((e) => e.pattern));
  const shared = new Set(observed.data.sharedGroupIds);
  for (const id of observed.data.topLevel.namespace) if (!union.has(id)) problems.push({ kind: "namespace-outside-union", id });
  for (const pattern of observed.data.namespacePatterns) {
    const last = pattern.split("/").at(-1);
    if (!union.has(last) && !exclusionPatterns.has(pattern)) problems.push({ kind: "namespace-pattern-outside-union", pattern });
    if (shared.has(last) && !exclusionPatterns.has(pattern)) problems.push({ kind: "shared-group-pattern-not-excluded", pattern });
  }
  for (const pattern of observed.data.foreignParentPrefixed) if (!exclusionPatterns.has(pattern)) problems.push({ kind: "foreign-parent-not-excluded", pattern });
  for (const id of observed.data.sharedGroupIds) if (union.has(id)) problems.push({ kind: "shared-group-in-union", id });
  return problems;
}

function workloadProblems(observed, census, accepted) {
  const problems = [];
  const writers = computeWriterSet(observed.identity);
  const attribution = new Map(observed.workload.attribution.map((a) => [a.digest, a]));
  const codeSites = new Set(census.codeCensus.map((c) => `${c.repository}@${c.commit}`));
  const unattributable = new Set((accepted.find((a) => a.id === "unattributable-workload")?.subjects) ?? []);
  for (const w of observed.workload.workloads) {
    if (!writers.has(w.serviceAccount)) continue;
    const subject = `${w.kind}/${w.location}/${w.name}`;
    for (const image of w.images) {
      if (!image.digest) {
        if (!unattributable.has(subject)) problems.push({ kind: "unattributed-image", subject });
        continue;
      }
      const a = attribution.get(image.digest);
      if (!a || a.method === "unmapped") {
        if (!unattributable.has(subject)) problems.push({ kind: "unattributed-image", subject });
        continue;
      }
      // E5: a cloud-build or ar-tag attribution must carry a commit. Its absence is unattributed, never skipped.
      if (!a.commit || !a.sourceRepository) {
        if (!unattributable.has(subject)) problems.push({ kind: "unattributed-image", subject });
        continue;
      }
      if (!codeSites.has(`${a.sourceRepository}@${a.commit}`)) problems.push({ kind: "attributed-commit-not-in-code-census", subject });
    }
  }
  // E16: every readable admitted row is code that runs as the deployer, so its head commit must be in the code census.
  for (const row of observed.ci.admittedState) {
    if (row.readable && !codeSites.has(`${row.repository}@${row.headCommit}`)) problems.push({ kind: "admitted-commit-not-in-code-census", subject: `${row.repository}@${row.ref}` });
  }
  for (const repo of census.codeCensus) {
    for (const site of repo.writeSites) {
      if ((site.role === "migration" || site.role === "meta" || site.role === "operations") && site.fence === "none") {
        problems.push({ kind: "unfenced-write-site", repository: repo.repository, file: site.file, line: site.line });
      }
    }
  }
  return problems;
}

export function compareCensus(input) {
  assertInventoryBinding(input?.binding);
  const { census, observed, measurements, surfaces, scopeGroups, binding } = input;
  const problems = [];
  const surfaceIssues = surfaceProblems(surfaces, observed);
  const incomplete = surfaceIssues.find((p) => p.kind === "incomplete-surfaces")?.surfaces ?? [];
  problems.push(...surfaceIssues);

  const census2 = census && census.schemaVersion === CENSUS_SCHEMA ? census : null;
  if (!census2) problems.push({ kind: "census-missing-or-invalid" });
  else {
    problems.push(...validateCensus(census2, binding).map((p) => ({ kind: "census-shape", at: p.at, detail: p.kind })));
  }
  const observedProblems = observed ? validateObserved(observed, binding) : [{ kind: "observation-missing" }];
  problems.push(...observedProblems.map((p) => ({ kind: "observed-shape", at: p.at, detail: p.kind })));
  if (census2 && census2.observed) {
    problems.push(...validateObserved(census2.observed, binding).map((p) => ({ kind: "census-observed-shape", at: p.at, detail: p.kind })));
  }

  if (census2 && observed && canonicalJson(census2.observed) !== canonicalJson(observed)) problems.push({ kind: "observed-mismatch" });

  if (census2 && observed && observedProblems.length === 0) {
    const emitted = normalizeAssumptions(emittedAssumptions(observed, census2));
    const accepted = normalizeAssumptions(census2.acceptedAssumptions);
    if (canonicalJson(emitted) !== canonicalJson(accepted)) problems.push({ kind: "assumptions-not-accepted" });
    problems.push(...dataProblems(observed, census2));
    problems.push(...workloadProblems(observed, census2, accepted));
  }

  const leakSurfaces = Object.fromEntries(Object.entries(surfaces ?? {}).map(([k, v]) => [k, v.error ?? null]));
  const leaks = [
    ...findRawLeaks(observed ?? null, "observed"),
    ...findRawLeaks(measurements ?? null, "measurements"),
    ...findRawLeaks(leakSurfaces, "surfaces"),
  ];
  if (leaks.length) problems.push({ kind: "raw-leak", paths: leaks });

  if (!Array.isArray(scopeGroups)) problems.push({ kind: "scope-missing-or-invalid" });
  else if (census2) {
    const union = [...census2.union].sort();
    const scope = [...scopeGroups].sort();
    if (JSON.stringify(union) !== JSON.stringify(scope)) problems.push({ kind: "union-not-scope" });
  }

  return { decision: problems.length === 0 ? "match" : "fail", incomplete, problems };
}
