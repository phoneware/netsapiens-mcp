import * as http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Normalizes an HTTP method and OpenAPI path into an OperationKey.
 * Throws an error for unsupported methods.
 *
 * @param {string} method
 * @param {string} path
 * @returns {string}
 */
export function normalizeOperationKey(method, path) {
 const upper = method.toUpperCase();
 if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(upper)) {
  throw new Error(`Unsupported operation method: ${method}`);
 }
 let normalized = path.replace(/#\d+$/, '');
 if (normalized !== '/') normalized = normalized.replace(/\/$/, '');
 normalized = normalized.split('/').map(segment => segment === '~' || /^\{[^}]*\}$/.test(segment) ? '{}' : segment).join('/');
 return `${upper} ${normalized}`;
}

/**
 * Resolves the highest documentation branch less than or equal to the major.minor of apiVersion.
 *
 * @param {string | null | undefined} apiVersion
 * @param {string[]} branches
 * @returns {string}
 */
export function getDocsBranch(apiVersion, branches) {
 if (!apiVersion) {
  return branches[0];
 }
 const match = String(apiVersion).match(/^(\d+)\.(\d+)/);
 if (!match) return branches[0];
 const major = parseInt(match[1], 10);
 const minor = parseInt(match[2], 10);

 const candidates = branches.filter((b) => {
  const bMatch = b.match(/^(\d+)\.(\d+)/);
  if (!bMatch) return false;
  const bMajor = parseInt(bMatch[1], 10);
  const bMinor = parseInt(bMatch[2], 10);
  return bMajor < major || (bMajor === major && bMinor <= minor);
 });

 if (candidates.length === 0) {
  return branches[0];
 }

 candidates.sort((a, b) => {
  const aM = a.match(/^(\d+)\.(\d+)/).map(Number);
  const bM = b.match(/^(\d+)\.(\d+)/).map(Number);
  if (aM[1] !== bM[1]) return aM[1] - bM[1];
  return aM[2] - bM[2];
 });

 return candidates[candidates.length - 1];
}

/**
 * Matches a request path against a template path (supports {}, {name}, and :name parameters).
 * Returns an object of extracted parameters if matched, or null if not matched.
 *
 * @param {string} templatePath
 * @param {string} requestPath
 * @returns {Record<string, string> | null}
 */
export function matchPath(templatePath, requestPath) {
 let t = templatePath;
 let r = requestPath;
 if (t !== '/') t = t.replace(/\/$/, '');
 if (r !== '/') r = r.replace(/\/$/, '');

 const tSegs = t.split('/');
 const rSegs = r.split('/');
 if (tSegs.length !== rSegs.length) return null;

 const params = {};
 for (let i = 0; i < tSegs.length; i++) {
  const ts = tSegs[i];
  const rs = rSegs[i];
  if (ts === '{}') {
   continue;
  }
  if (ts.startsWith('{') && ts.endsWith('}')) {
   params[ts.slice(1, -1)] = rs;
   continue;
  }
  if (ts.startsWith(':')) {
   params[ts.slice(1)] = rs;
   continue;
  }
  if (ts !== rs) {
   return null;
  }
 }
 return params;
}

/**
 * Finds the best matching OperationKey in availableKeys, taking into account forceAbsentSet.
 *
 * @param {string} method
 * @param {string} v2Path
 * @param {Set<string>} availableKeys
 * @param {Set<string>} forceAbsentSet
 * @returns {string | null}
 */
export function findMatchingOperationKey(method, v2Path, availableKeys, forceAbsentSet = new Set()) {
 const prefix = method + ' ';
 let bestMatch = null;
 let bestWildcards = Infinity;

 for (const key of availableKeys) {
  if (!key.startsWith(prefix)) continue;
  const templatePath = key.slice(prefix.length);
  const params = matchPath(templatePath, v2Path);
  if (params !== null) {
   const tSegs = templatePath.split('/');
   let wildcards = 0;
   for (const seg of tSegs) {
    if (seg === '{}' || seg.startsWith('{') || seg.startsWith(':')) {
     wildcards++;
    }
   }
   if (wildcards < bestWildcards) {
    bestWildcards = wildcards;
    bestMatch = key;
   }
  }
 }

 if (bestMatch !== null) {
  for (const key of forceAbsentSet) {
   if (!key.startsWith(prefix)) continue;
   const templatePath = key.slice(prefix.length);
   const params = matchPath(templatePath, v2Path);
   if (params !== null) {
    const tSegs = templatePath.split('/');
    let wildcards = 0;
    for (const seg of tSegs) {
     if (seg === '{}' || seg.startsWith('{') || seg.startsWith(':')) {
      wildcards++;
     }
    }
    if (wildcards <= bestWildcards) {
     return null;
    }
   }
  }
 }

 return bestMatch;
}

const branchKeysCache = new Map();
const apidocCache = new Map();

async function getBranchData(specRoot) {
 if (branchKeysCache.has(specRoot)) {
  return branchKeysCache.get(specRoot);
 }
 const branchesPath = resolve(specRoot, 'v2/BRANCHES.json');
 let branches;
 try {
  const raw = await readFile(branchesPath, 'utf8');
  branches = JSON.parse(raw);
 } catch {
  branches = ['44.3', '44.4', '45.0', '46.0'];
 }

 const branchMap = new Map();
 for (const branch of branches) {
  const specFile = resolve(specRoot, `v2/${branch}.json`);
  const raw = await readFile(specFile, 'utf8');
  const spec = JSON.parse(raw);
  const keys = new Set();
  if (spec.paths) {
   for (const [p, ops] of Object.entries(spec.paths)) {
    for (const m of Object.keys(ops)) {
     if (['get', 'post', 'put', 'patch', 'delete'].includes(m.toLowerCase())) {
      keys.add(normalizeOperationKey(m, p));
     }
    }
   }
  }
  branchMap.set(branch, keys);
 }

 const result = { branches, branchMap };
 branchKeysCache.set(specRoot, result);
 return result;
}

async function getFullApidoc(specRoot) {
 if (apidocCache.has(specRoot)) {
  return apidocCache.get(specRoot);
 }
 const filePath = resolve(specRoot, 'v1/apidoc-44.4.10.json');
 const raw = await readFile(filePath, 'utf8');
 const parsed = JSON.parse(raw);
 const reduced = parsed.map((item) => ({
  type: item.type,
  url: item.url,
 }));
 apidocCache.set(specRoot, reduced);
 return reduced;
}

function lookupToken(tokens, token) {
 if (!tokens || !token) return undefined;
 if (tokens instanceof Map) {
  return tokens.get(token);
 }
 if (typeof tokens === 'object' && Object.prototype.hasOwnProperty.call(tokens, token)) {
  return tokens[token];
 }
 return undefined;
}

function parseOpKey(key) {
 const parts = key.trim().split(/\s+/);
 if (parts.length === 2) {
  return normalizeOperationKey(parts[0], parts[1]);
 }
 return key;
}

/**
 * Starts a fake NetSapiens HTTP server for local testing.
 *
 * @param {Object} [options]
 * @param {string | null} [options.apiVersion='44.4.10']
 * @param {number} [options.versionStatus=200]
 * @param {'full' | 'missing' | Array<{type: string, url: string}>} [options.apidoc='missing']
 * @param {Map<string, any> | Record<string, any>} [options.tokens]
 * @param {string[]} [options.extraPresent]
 * @param {string[]} [options.forceAbsent]
 * @param {Array<Function | Object>} [options.routeModules]
 * @param {string} [options.specRoot]
 * @param {string} [options.hostname='127.0.0.1']
 * @param {Record<string, any>} [options.state]
 * @returns {Promise<{
 *   origin: string,
 *   requests: Array<{ method: string, path: string, query: Record<string, string | string[]>, body: any, hasAuth: boolean, headers: http.IncomingHttpHeaders }>,
 *   state: Record<string, any>,
 *   setApiVersion: (v: string | null) => void,
 *   setVersionStatus: (code: number) => void,
 *   setApidoc: (x: 'full' | 'missing' | Array<{type: string, url: string}>) => void,
 *   setExtraPresent: (arr: string[]) => void,
 *   setForceAbsent: (arr: string[]) => void,
 *   setTokens: (t: Map<string, any> | Record<string, any>) => void,
 *   close: () => Promise<void>
 * }>}
 */
export async function startFakeNetSapiens(options = {}) {
 const defaultSpecRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../spec');
 const specRoot = options.specRoot ?? defaultSpecRoot;
 const hostname = options.hostname ?? '127.0.0.1';

 let currentApiVersion = options.apiVersion !== undefined ? options.apiVersion : '44.4.10';
 let currentVersionStatus = options.versionStatus ?? 200;
 let currentApidoc = options.apidoc ?? 'missing';
 let currentTokens = options.tokens;
 let extraPresentList = [...(options.extraPresent ?? [])];
 let forceAbsentList = [...(options.forceAbsent ?? [])];

 const state = options.state ?? {};
 const requests = [];

 const { branches, branchMap } = await getBranchData(specRoot);

 const customRoutes = [];
 for (const item of options.routeModules ?? []) {
  const defs = typeof item === 'function' ? item(state) : item;
  if (Array.isArray(defs)) {
   customRoutes.push(...defs);
  } else if (defs && typeof defs === 'object') {
   customRoutes.push(defs);
  }
 }

 const server = http.createServer(async (req, res) => {
  try {
   const url = new URL(req.url, `http://${req.headers.host || hostname}`);
   const method = req.method.toUpperCase();
   const authHeader = req.headers['authorization'];
   const hasAuth = Boolean(authHeader && authHeader.trim().length > 0);
   const bearerMatch = typeof authHeader === 'string' ? authHeader.match(/^Bearer\s+(.+)$/i) : null;
   const bearerToken = bearerMatch ? bearerMatch[1].trim() : null;

   const query = {};
   for (const [key, value] of url.searchParams.entries()) {
    if (key in query) {
     if (Array.isArray(query[key])) {
      query[key].push(value);
     } else {
      query[key] = [query[key], value];
     }
    } else {
     query[key] = value;
    }
   }

   const chunks = [];
   for await (const chunk of req) {
    chunks.push(chunk);
   }
   const rawBody = Buffer.concat(chunks).toString('utf8');
   let body = rawBody;
   if (rawBody) {
    try {
     body = JSON.parse(rawBody);
    } catch {
     body = rawBody;
    }
   } else {
    body = null;
   }

   requests.push({
    method,
    path: url.pathname,
    query,
    body,
    hasAuth,
    headers: req.headers,
   });

   // Special unauthenticated endpoint: /version
   if (url.pathname === '/ns-api/v2/version' || url.pathname === '/version') {
    if (method === 'GET') {
     if (currentApiVersion === null) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
      return;
     }
     res.writeHead(currentVersionStatus, { 'Content-Type': 'application/json' });
     res.end(JSON.stringify({ apiversion: currentApiVersion }));
     return;
    }
   }

   // Special unauthenticated endpoint: /apidoc
   if (url.pathname === '/ns-api/webroot/apidoc/api_data.json' || url.pathname === '/webroot/apidoc/api_data.json') {
    if (method === 'GET') {
     if (currentApidoc === 'missing') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found' }));
      return;
     }
     if (currentApidoc === 'full') {
      const fullDoc = await getFullApidoc(specRoot);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fullDoc));
      return;
     }
     if (Array.isArray(currentApidoc)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(currentApidoc));
      return;
     }
     res.writeHead(404, { 'Content-Type': 'application/json' });
     res.end(JSON.stringify({ message: 'Not Found' }));
     return;
    }
   }

   // Normalize path for general v2 routing
   let v2Path = url.pathname;
   if (v2Path.startsWith('/ns-api/v2/')) {
    v2Path = v2Path.slice(10);
   } else if (v2Path === '/ns-api/v2') {
    v2Path = '/';
   }
   if (v2Path !== '/') v2Path = v2Path.replace(/\/$/, '');

   // Check custom route modules
   let matchedRouteModule = null;
   let routeParams = {};
   for (const route of customRoutes) {
    if (route.method.toUpperCase() === method) {
     let rPath = route.path;
     if (rPath.startsWith('/ns-api/v2/')) {
      rPath = rPath.slice(10);
     } else if (rPath === '/ns-api/v2') {
      rPath = '/';
     }
     if (rPath !== '/') rPath = rPath.replace(/\/$/, '');

     const params = matchPath(rPath, v2Path);
     if (params !== null) {
      matchedRouteModule = route;
      routeParams = params;
      break;
     }
    }
   }

   // Build active available operations set for current apiVersion
   const branch = getDocsBranch(currentApiVersion, branches);
   const branchKeys = branchMap.get(branch) ?? new Set();
   const availableKeys = new Set(branchKeys);

   for (const ep of extraPresentList) {
    availableKeys.add(parseOpKey(ep));
   }
   const forceAbsentSet = new Set();
   for (const fa of forceAbsentList) {
    const normFa = parseOpKey(fa);
    availableKeys.delete(normFa);
    forceAbsentSet.add(normFa);
   }

   // Check operation matching
   const matchedOpKey = findMatchingOperationKey(method, v2Path, availableKeys, forceAbsentSet);
   const inSet = matchedOpKey !== null || matchedRouteModule !== null;

   // 404 if not in set
   if (!inSet) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'No Route Found' }));
    return;
   }

   // Check bearer authorization
   const isUnauthRoute = matchedRouteModule?.unauthenticated || matchedRouteModule?.auth === false;
   if (!isUnauthRoute && !bearerToken) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 400, message: 'missing an access token' }));
    return;
   }

   // Execute custom route handler if available
   if (matchedRouteModule) {
    const reqCtx = {
     method,
     path: url.pathname,
     query,
     body,
     headers: req.headers,
     params: routeParams,
     token: bearerToken,
     state,
    };
    const response = await matchedRouteModule.handler(reqCtx);
    const status = response?.status ?? 200;
    const respHeaders = { ...(response?.headers ?? {}) };
    let respBody = response?.body !== undefined ? response.body : response;
    if (respBody !== null && typeof respBody === 'object' && !Buffer.isBuffer(respBody)) {
     respBody = JSON.stringify(respBody);
     if (!respHeaders['Content-Type'] && !respHeaders['content-type']) {
      respHeaders['Content-Type'] = 'application/json';
     }
    }
    res.writeHead(status, respHeaders);
    res.end(respBody ?? '');
    return;
   }

   // Built-in token sign-in and role detection handler
   if (matchedOpKey === 'GET /domains/{}/users/{}' || matchedOpKey === 'GET /apikeys/{}') {
    const userRecord = lookupToken(currentTokens, bearerToken);
    if (userRecord !== undefined) {
     const respData = typeof userRecord === 'function' ? await userRecord({ method, path: url.pathname, query, body, headers: req.headers, token: bearerToken, state }) : userRecord;
     res.writeHead(200, { 'Content-Type': 'application/json' });
     res.end(JSON.stringify(respData));
     return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 401, message: 'Unauthorized' }));
    return;
   }

   // Documented path with bearer but no handler
   res.writeHead(501, { 'Content-Type': 'application/json' });
   res.end(JSON.stringify({ message: 'fake: no handler' }));
  } catch (err) {
   res.writeHead(500, { 'Content-Type': 'application/json' });
   res.end(JSON.stringify({ error: err.message }));
  }
 });

 await new Promise((resolveListen) => {
  server.listen(0, hostname, resolveListen);
 });

 const addr = server.address();
 const origin = `http://${hostname}:${addr.port}`;

 return {
  origin,
  requests,
  state,
  setApiVersion(v) {
   currentApiVersion = v;
  },
  setVersionStatus(code) {
   currentVersionStatus = code;
  },
  setApidoc(x) {
   currentApidoc = x;
  },
  setExtraPresent(arr) {
   extraPresentList = [...arr];
  },
  setForceAbsent(arr) {
   forceAbsentList = [...arr];
  },
  setTokens(t) {
   currentTokens = t;
  },
  async close() {
   if (server.closeAllConnections) {
    server.closeAllConnections();
   }
   return new Promise((resolveClose, rejectClose) => {
    server.close((err) => (err ? rejectClose(err) : resolveClose()));
   });
  },
 };
}
