import { canonicalJson } from "./dsse-verifier-core.mjs";

// Authenticated observations only. Approval is supplied by a separate signed
// manifest; these reads cannot authorize their own schema changes.
export async function readFirestoreAdminIndexes({ project, database, collectionGroups, requiredFields, accessToken, fetchFn = fetch }) {
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project) || database !== "(default)" ||
    !Array.isArray(collectionGroups) || !collectionGroups.length ||
    new Set(collectionGroups).size !== collectionGroups.length ||
    collectionGroups.some((name) => !/^[A-Za-z0-9_-]+$/.test(name)) ||
    !requiredFields || typeof requiredFields !== "object" || Array.isArray(requiredFields) ||
    Object.keys(requiredFields).length !== collectionGroups.length ||
    collectionGroups.some((name) => !Array.isArray(requiredFields[name]) || new Set(requiredFields[name]).size !== requiredFields[name].length ||
      requiredFields[name].some((field) => typeof field !== "string" || !/^[_A-Za-z][_A-Za-z0-9]*(\.[_A-Za-z][_A-Za-z0-9]*)*$/.test(field))) ||
    typeof accessToken !== "string" || !accessToken) throw new Error("Invalid approved Admin read binding");
  const databaseName = `projects/${project}/databases/${database}`;
  const base = `https://firestore.googleapis.com/v1/${databaseName}`;
  const request = async (url) => {
    const response = await fetchFn(url, { headers: { authorization: `Bearer ${accessToken}` }, redirect: "error" });
    if (!response.ok) throw new Error(`Firestore Admin read failed: HTTP ${response.status}`);
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed Admin response");
    return value;
  };
  const pages = async (url, filter, key) => {
    const result = [], seen = new Set();
    let token = "";
    do {
      const next = new URL(url);
      if (filter) next.searchParams.set("filter", filter);
      next.searchParams.set("pageSize", "100");
      if (token) next.searchParams.set("pageToken", token);
      const data = await request(next.href);
      if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error("Malformed Admin page");
      result.push(...(data[key] ?? []));
      token = data.nextPageToken ?? "";
      if (typeof token !== "string" || (token && seen.has(token))) throw new Error("Invalid Admin pagination cursor");
      if (token) seen.add(token);
    } while (token);
    return result;
  };
  const validField = (name) => typeof name === "string" && name.startsWith(`${databaseName}/collectionGroups/`) &&
    /^projects\/[^/]+\/databases\/[^/]+\/collectionGroups\/[^/]+\/fields\/[^/]+$/.test(name);
  const fieldCache = new Map();
  const getField = async (name) => {
    if (!validField(name)) throw new Error("Invalid Firestore ancestor field reference");
    if (!fieldCache.has(name)) {
      const value = await request(`https://firestore.googleapis.com/v1/${name.split("/").map(encodeURIComponent).join("/")}`);
      if (value.name !== name) throw new Error("Firestore field resource mismatch");
      fieldCache.set(name, value);
    }
    return fieldCache.get(name);
  };
  const resolveField = async (field) => {
    const visited = new Set();
    while (true) {
      if (!validField(field.name) || visited.has(field.name)) throw new Error("Invalid or cyclic index inheritance");
      visited.add(field.name);
      const config = field.indexConfig;
      if (!config || config.reverting === true) throw new Error("Missing or changing Firestore index configuration");
      if (config.usesAncestorConfig === true) {
        field = await getField(config.ancestorField);
      } else if (config.usesAncestorConfig === false || config.usesAncestorConfig === undefined) {
        if (config.indexes !== undefined && !Array.isArray(config.indexes)) throw new Error("Malformed explicit Firestore index list");
        return { source: field.name, chain: [...visited], indexes: config.indexes ?? [] };
      } else throw new Error("Unknown Firestore index inheritance state");
    }
  };
  const defaultField = await getField(`${databaseName}/collectionGroups/__default__/fields/*`);
  const defaultIndexes = await resolveField(defaultField);
  const collections = [];
  for (const collectionGroup of [...collectionGroups].sort()) {
    const parent = `${base}/collectionGroups/${encodeURIComponent(collectionGroup)}`;
    const [overrides, ttl, composites] = await Promise.all([
      pages(`${parent}/fields`, "indexConfig.usesAncestorConfig:false", "fields"),
      pages(`${parent}/fields`, "ttlConfig:*", "fields"),
      pages(`${parent}/indexes`, "", "indexes"),
    ]);
    const names = new Set();
    for (const field of [...overrides, ...ttl]) {
      if (!validField(field.name) || !field.name.startsWith(`${databaseName}/collectionGroups/${collectionGroup}/fields/`)) throw new Error("Unexpected Firestore field resource");
      names.add(field.name);
    }
    for (const fieldPath of requiredFields[collectionGroup]) {
      names.add(`${databaseName}/collectionGroups/${collectionGroup}/fields/${fieldPath}`);
    }
    const resolved = [];
    for (const name of [...names].sort()) {
      const field = await getField(name);
      if (field.ttlConfig && field.ttlConfig.state !== "ACTIVE") throw new Error("Firestore TTL is not active");
      resolved.push({ name, index: await resolveField(field), ttlConfig: field.ttlConfig ?? null });
    }
    for (const index of composites) {
      if (index.state !== "READY" || typeof index.name !== "string" ||
        !index.name.startsWith(`${databaseName}/collectionGroups/${collectionGroup}/indexes/`)) throw new Error("Firestore composite index is not ready");
    }
    collections.push({ collectionGroup, fields: resolved, composites, requiredFields: [...requiredFields[collectionGroup]].sort() });
  }
  return { databaseResource: databaseName, defaultIndexes, collections, paginationComplete: true };
}

const sort = (items) => [...items].sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0);
function indexField(field) {
  if (!field || typeof field.fieldPath !== "string" || !field.fieldPath) throw new Error("Unknown index field");
  const options = [field.order && ["order", field.order], field.arrayConfig && ["arrayConfig", field.arrayConfig], field.vectorConfig && ["vectorConfig", field.vectorConfig]].filter(Boolean);
  if (options.length !== 1 || options[0][0] === "vectorConfig" || (options[0][0] === "order" && !["ASCENDING", "DESCENDING"].includes(options[0][1])) || (options[0][0] === "arrayConfig" && options[0][1] !== "CONTAINS")) throw new Error("Unsupported Firestore index field");
  return { fieldPath: field.fieldPath, [options[0][0]]: options[0][1] };
}
function single(index) {
  if (index.state !== undefined && index.state !== "READY") throw new Error("Single-field index is not ready");
  if (!["COLLECTION", "COLLECTION_GROUP"].includes(index.queryScope) || !Array.isArray(index.fields) || index.fields.length !== 1) throw new Error("Unsupported single-field index");
  const { fieldPath: _fieldPath, ...mode } = indexField(index.fields[0]);
  return { queryScope: index.queryScope, ...mode };
}
function composite(index) {
  if (!["COLLECTION", "COLLECTION_GROUP"].includes(index.queryScope) || !Array.isArray(index.fields) || !index.fields.length) throw new Error("Unsupported composite index");
  return { queryScope: index.queryScope, fields: index.fields.map(indexField) };
}
export function projectIndexObservation({ databaseResource, collectionGroups, observation }) {
  if (typeof databaseResource !== "string" || !databaseResource || observation?.databaseResource !== databaseResource ||
    observation.paginationComplete !== true || !Array.isArray(collectionGroups) || !collectionGroups.length ||
    new Set(collectionGroups).size !== collectionGroups.length || !Array.isArray(observation.collections) ||
    !Array.isArray(observation.defaultIndexes?.indexes)) throw new Error("Incomplete protected index inputs");
  const groups = [...collectionGroups].sort();
  if (canonicalJson(groups) !== canonicalJson(observation.collections.map((entry) => entry.collectionGroup).sort())) throw new Error("Firestore collection-group coverage mismatch");
  const defaultIndexes = sort(observation.defaultIndexes.indexes.map(single)), defaultChain = observation.defaultIndexes.chain;
  const defaultName = `${databaseResource}/collectionGroups/__default__/fields/*`;
  if (!Array.isArray(defaultChain) || !defaultChain.length || defaultChain[0] !== defaultName || defaultChain[defaultChain.length - 1] !== observation.defaultIndexes.source ||
    new Set(defaultChain).size !== defaultChain.length || defaultChain.some((name) => typeof name !== "string" || !name.startsWith(`${databaseResource}/collectionGroups/`))) throw new Error("Invalid default index inheritance chain");
  const collections = groups.map((group) => {
    const observed = observation.collections.find((entry) => entry.collectionGroup === group);
    if (!Array.isArray(observed.fields) || !Array.isArray(observed.composites) || !Array.isArray(observed.requiredFields) ||
      new Set(observed.requiredFields).size !== observed.requiredFields.length || observed.composites.some((index) => index.state !== "READY")) throw new Error("Incomplete Admin collection observation");
    const overrides = [], ttl = [], effectiveFields = [], composites = sort(observed.composites.map(composite));
    for (const field of observed.fields) {
      const prefix = `${databaseResource}/collectionGroups/${group}/fields/`;
      if (typeof field.name !== "string" || !field.name.startsWith(prefix) || !field.index || !Array.isArray(field.index.indexes)) throw new Error("Malformed effective field observation");
      const fieldPath = field.name.slice(prefix.length), chain = field.index.chain;
      if (!/^[_A-Za-z][_A-Za-z0-9]*(\.[_A-Za-z][_A-Za-z0-9]*)*$/.test(fieldPath) || !Array.isArray(chain) || !chain.length || chain[0] !== field.name ||
        chain[chain.length - 1] !== field.index.source || new Set(chain).size !== chain.length ||
        chain.some((name) => typeof name !== "string" || !name.startsWith(`${databaseResource}/collectionGroups/`))) throw new Error("Malformed field inheritance chain");
      const indexes = sort(field.index.indexes.map(single));
      effectiveFields.push({ fieldPath, indexes, source: field.index.source, chain });
      if (field.index.source === field.name) overrides.push({ fieldPath, indexes });
      if (field.ttlConfig) {
        if (field.ttlConfig.state !== "ACTIVE" || (field.ttlConfig.expirationOffset && field.ttlConfig.expirationOffset !== "0s")) throw new Error("Unsupported TTL state or offset");
        ttl.push({ fieldPath, state: "ACTIVE" });
      }
    }
    if (new Set(effectiveFields.map((field) => field.fieldPath)).size !== effectiveFields.length ||
      observed.requiredFields.some((fieldPath) => !effectiveFields.some((field) => field.fieldPath === fieldPath))) throw new Error(`Incomplete effective field coverage for ${group}`);
    return { collectionGroup: group, requiredFields: [...observed.requiredFields].sort(), effectiveFields: sort(effectiveFields), overrides: sort(overrides), composites, ttl: sort(ttl) };
  });
  return {
    policy: { default: { source: observation.defaultIndexes.source, indexes: defaultIndexes }, collections: collections.map(({ collectionGroup, overrides, composites, ttl }) => ({ collectionGroup, overrides, composites, ttl })) },
    coverage: collections.map(({ collectionGroup, requiredFields, effectiveFields }) => ({ collectionGroup, requiredFields, effectiveFields })),
  };
}