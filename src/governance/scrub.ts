import type { ContentKind, FieldClass, FieldRule, OutputDeclaration, ScrubResult } from './types.js';
import { NS_RESOURCE_FIELDS } from './ns-fields.generated.js';

/**
 * Known unambiguous credential field names from NetSapiens schemas that must
 * always be scrubbed when encountered at any depth.
 */
export const UNAMBIGUOUS_SECRET_NAMES: Record<string, true> = {
 'device-sip-registration-password': true,
 'device-provisioning-password': true,
 'voicemail-login-pin': true,
 'email-send-smtp-password': true,
 smtp_pwd: true,
 client_secret: true,
 'client-secret': true,
 password: true,
 passcode: true,
 pin: true,
 secret: true,
 mfa: true,
 subscriber_pin: true,
 pwd_hash: true,
 pwd: true,
 auth_pass: true,
 authentication_key: true,
 'connection-sip-registration-password': true,
 'global-one-time-pass': true,
 'meeting-passcode': true,
 leader_pin: true,
 speaker_pin: true,
 participants_pin: true,
 SipSipAuthKey: true,
 access_token: true,
 refresh_token: true,
 data_token: true,
 idtoken: true,
 api_key: true,
 'api-key': true,
 auth_token: true,
 'auth-token': true,
};

/**
 * Matches a current path against a rule path pattern.
 */
function pathMatches(rulePath: string, currentPath: string): boolean {
 if (rulePath === currentPath) return true;
 if (!rulePath || !currentPath) return false;

 const ruleSegments = rulePath.split('.');
 const currentSegments = currentPath.split('.');

 if (ruleSegments.length !== currentSegments.length) return false;

 for (let i = 0; i < ruleSegments.length; i++) {
  const r = ruleSegments[i];
  const c = currentSegments[i];
  if (r === '*' || r === c) continue;
  return false;
 }
 return true;
}

/**
 * Handles container prefixes and array shorthand between rules and walk paths.
 */
function pathMatchesRule(rulePath: string, currentPath: string): boolean {
 if (pathMatches(rulePath, currentPath)) return true;
 if (!currentPath && (rulePath === 'data' || rulePath === '')) return true;
 if (rulePath === 'data[]' && (currentPath === '[]' || currentPath === 'data[]')) return true;
 if (rulePath.startsWith('data.') && pathMatches(rulePath, `data.${currentPath}`)) return true;
 if (rulePath.startsWith('data[]') && pathMatches(rulePath, `data${currentPath}`)) return true;
 return false;
}

/**
 * Finds the resource context applicable at the given path based on OutputDeclaration rules.
 */
function findResourceForPath(
 rules: readonly FieldRule[] | undefined,
 path: string,
): string | undefined {
 if (!rules) return undefined;
 for (const rule of rules) {
  if ('resource' in rule && pathMatchesRule(rule.path, path)) {
   return rule.resource;
  }
 }
 return undefined;
}

/**
 * Recursively removes secret-class fields at any depth from a tool result payload.
 *
 * A field is scrubbed if:
 * 1. An OutputDeclaration rule explicitly marks its path as secret ({ class: 'secret' }).
 * 2. An OutputDeclaration rule maps its parent to an NS resource where the field is classified as secret.
 * 3. The field name matches a known secret field from NetSapiens schemas (defense in depth).
 * 4. The field name matches credential-shaped keys (password, pin, secret, token, passcode, key)
 *    regardless of value type (string, number, object).
 *
 * Returns { scrubbed, count } where count is the total number of secret fields removed.
 * Never logs or returns secret values.
 */
export function scrubSecrets<T = unknown>(
 payload: T,
 output?: OutputDeclaration,
): ScrubResult<T> {
 let count = 0;

 function scrub(val: unknown, currentPath: string, activeResource?: string): unknown {
  if (val === null || val === undefined) {
   return val;
  }

  if (Array.isArray(val)) {
   const arrayItemPath = currentPath ? `${currentPath}[]` : '[]';
   const itemResource = findResourceForPath(output?.rules, arrayItemPath) ?? activeResource;
   return val.map((item) => scrub(item, arrayItemPath, itemResource));
  }

  if (typeof val === 'object') {
   const obj = val as Record<string, unknown>;
   const result: Record<string, unknown> = {};

   // Check if current object path maps to a resource
   const objResource =
    (currentPath ? findResourceForPath(output?.rules, currentPath) : undefined) ?? activeResource;

   for (const [key, value] of Object.entries(obj)) {
    const propPath = currentPath ? `${currentPath}.${key}` : key;

    // Check if field is classified as secret
    let isSecret = false;

    // 1. Direct field rule match
    if (output?.rules) {
     for (const rule of output.rules) {
      if ('field' in rule && pathMatchesRule(rule.path, propPath) && rule.field.class === 'secret') {
       isSecret = true;
       break;
      }
     }
    }

    // 2. Resource field match
    if (!isSecret && objResource && NS_RESOURCE_FIELDS[objResource]?.[key]?.class === 'secret') {
     isSecret = true;
    }

    // 3. Known unambiguous secret name check (any depth)
    if (!isSecret && UNAMBIGUOUS_SECRET_NAMES[key]) {
     isSecret = true;
    }

    // 4. Contextual and credential-shaped secret rules (regardless of value type)
    if (!isSecret) {
     if (/^(?:password|pin|secret|passcode|token)$/i.test(key)) {
      isSecret = true;
     } else if (
      /(?:^|[-_])(?:password|pin|secret|passcode)(?:$|[-_])/i.test(key) &&
      // Same exclusions as the generator (scripts/generate-governance.ts): a setting such as
      // meeting-join-require-passcode-enabled describes a credential, it is not one.
      !/timeframe|status|-enabled$|dtmf-mapping|language-token/i.test(key)
     ) {
      isSecret = true;
     } else if (key === 'key') {
      if ('key-id' in obj || 'can-create-keys' in obj || 'key_id' in obj || 'api_key' in obj) {
       isSecret = true;
      }
     } else if (key === 'refresh' && ('token' in obj || 'access_token' in obj)) {
      isSecret = true;
     }
    }

    if (isSecret) {
     count++;
     // Drop secret field regardless of value type (string, number, object)
     continue;
    }

    // Recurse into non-secret fields
    const childResource = findResourceForPath(output?.rules, propPath) ?? undefined;
    result[key] = scrub(value, propPath, childResource);
   }

   return result;
  }

  if (typeof val === 'string') {
   const trimmed = val.trim();
   if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
     const parsed = JSON.parse(trimmed);
     if (parsed && typeof parsed === 'object') {
      const initialCount = count;
      const scrubbedParsed = scrub(parsed, currentPath, activeResource);
      if (count > initialCount) {
       return JSON.stringify(scrubbedParsed);
      }
     }
    } catch {
     // Plain text string
    }
   }
   return val;
  }

  return val;
 }

 const rootResource = findResourceForPath(output?.rules, '');
 const scrubbed = scrub(payload, '', rootResource) as T;

 return { scrubbed, count };
}

/**
 * Content field names that mean content in every resource that carries them. A name whose kind is stripped is
 * stripped even where no field class classifies it, so an unclassified copy cannot leak.
 */
export const UNAMBIGUOUS_CONTENT_NAMES: Readonly<Record<string, ContentKind>> = {
 'call-intelligence-summary': 'ai_summary',
 'call-intelligence-topics-top': 'ai_summary',
 'call-intelligence-topics-all': 'ai_summary',
 ending_sentiment: 'ai_summary',
 'call-intelligence-segments': 'transcript',
 'transcription-text': 'transcript',
 transcription_text: 'transcript',
 'voicemail-transcription': 'transcript',
 'vmail-transcription': 'transcript',
 'file-script-text': 'voicemail',
 'call-recording-remote-wav': 'call_recording',
 'messagesession-last-message': 'sms_text',
};

/** What projectOutput removes. With every option off, it only scrubs secrets, as scrubSecrets does. */
export interface ProjectOptions {
 /** Content kinds whose fields are removed. */
 readonly stripKinds?: readonly ContentKind[];
 /** Drop fields classified internal. */
 readonly dropInternal?: boolean;
 /** Drop every path the declaration does not name. A declaration with a wildcard root is refused. */
 readonly allowlist?: boolean;
}

export interface ProjectResult<T = unknown> {
 readonly projected: T;
 /** Fields removed per content kind. A kind with nothing removed is absent. */
 readonly stripped: Partial<Record<ContentKind, number>>;
 readonly internalDropped: number;
 readonly undeclaredDropped: number;
 /** Secret fields removed, counted exactly as scrubSecrets counts them. */
 readonly secrets: number;
}

interface Projection {
 readonly strip: ReadonlySet<ContentKind>;
 readonly dropInternal: boolean;
 readonly allowlist: boolean;
}

interface Removals {
 stripped: Partial<Record<ContentKind, number>>;
 internalDropped: number;
 undeclaredDropped: number;
 /** Every removal so far, so a nested JSON string can tell whether it changed. */
 total: number;
}

interface Walk {
 readonly rules: readonly FieldRule[];
 readonly projection: Projection;
 readonly removals: Removals;
}

/** A declaration rooted at a wildcard would name every path. The gates refuse it rather than guess. */
function assertRootedRules(rules: readonly FieldRule[]): void {
 for (const rule of rules) {
  if (rule.path.startsWith('*')) throw new Error(`Wildcard root declarations are not permitted: '${rule.path}'`);
 }
}

function countRemoval(removals: Removals, reason: 'internal' | 'undeclared' | ContentKind): void {
 removals.total += 1;
 if (reason === 'internal') removals.internalDropped += 1;
 else if (reason === 'undeclared') removals.undeclaredDropped += 1;
 else removals.stripped[reason] = (removals.stripped[reason] ?? 0) + 1;
}

interface KeyDeclaration {
 /** The first field rule naming this path. */
 readonly fieldRule: FieldClass | undefined;
 /** The field the object's resource table names for this key. */
 readonly tableField: FieldClass | undefined;
 /** A resource rule names this path, or a rule lies beneath it. */
 readonly structural: boolean;
}

function keyDeclaration(
 rules: readonly FieldRule[],
 table: Readonly<Record<string, Readonly<Record<string, FieldClass>>>>,
 propPath: string,
 objResource: string | undefined,
 key: string,
): KeyDeclaration {
 let fieldRule: FieldClass | undefined;
 for (const rule of rules) {
  if ('field' in rule && pathMatchesRule(rule.path, propPath)) {
   fieldRule = rule.field;
   break;
  }
 }
 const tableField =
  objResource !== undefined && Object.hasOwn(table, objResource) && Object.hasOwn(table[objResource], key)
   ? table[objResource][key]
   : undefined;
 return {
  fieldRule,
  tableField,
  structural: findResourceForPath(rules, propPath) !== undefined || isContainerPath(rules, propPath),
 };
}

/** Whether some rule names this path or lies beneath it. Used with findResourceForPath by the gate and the projector. */
function isContainerPath(rules: readonly FieldRule[], path: string): boolean {
 const prefixDot = `${path}.`;
 const prefixArray = `${path}[]`;
 const dataPrefixDot = `data.${path}.`;
 const dataPrefixArray = `data.${path}[]`;
 for (const rule of rules) {
  if (rule.path === path) return true;
  if (rule.path.startsWith(prefixDot) || rule.path.startsWith(prefixArray)) return true;
  if (rule.path.startsWith(dataPrefixDot) || rule.path.startsWith(dataPrefixArray)) return true;
  if (path === 'data' && (rule.path.startsWith('data.') || rule.path.startsWith('data[]'))) return true;
 }
 return false;
}

/**
 * The paths a payload has that the declaration does not name: the undeclared-path gate (spec 3.3). A key is
 * declared when a field rule or its resource table names it, or a resource rule or a rule beneath it does. A
 * declared field is not walked. Wildcard roots are refused.
 */
export function findUndeclaredPaths(
 payload: unknown,
 output?: OutputDeclaration,
 table: Readonly<Record<string, Readonly<Record<string, FieldClass>>>> = NS_RESOURCE_FIELDS,
): string[] {
 const rules = output?.rules ?? [];
 assertRootedRules(rules);
 const undeclared: string[] = [];

 function walkUndeclared(value: unknown, currentPath: string, activeResource: string | undefined): void {
  if (value === null || value === undefined || typeof value !== 'object') return;
  if (Array.isArray(value)) {
   const itemPath = currentPath ? `${currentPath}[]` : '[]';
   const itemResource = findResourceForPath(rules, itemPath) ?? findResourceForPath(rules, currentPath) ?? activeResource;
   for (const item of value) walkUndeclared(item, itemPath, itemResource);
   return;
  }
  const objResource = findResourceForPath(rules, currentPath) ?? activeResource;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
   const propPath = currentPath ? `${currentPath}.${key}` : key;
   if (Object.hasOwn(UNAMBIGUOUS_SECRET_NAMES, key)) continue;
   const declaration = keyDeclaration(rules, table, propPath, objResource, key);
   if (declaration.fieldRule !== undefined || declaration.tableField !== undefined) continue;
   if (declaration.structural) {
    walkUndeclared(child, propPath, findResourceForPath(rules, propPath) ?? objResource);
    continue;
   }
   undeclared.push(propPath);
  }
 }

 walkUndeclared(payload, '', undefined);
 return undeclared;
}

/**
 * Projects a tool result (spec 3.3). Secrets are scrubbed by scrubSecrets itself, so the output and the count
 * match it for every option set. The requested removals then run on that scrubbed payload: content fields of the
 * stripped kinds, internal fields, and in allowlist mode every undeclared path. Nested JSON strings are projected.
 */
export function projectOutput<T = unknown>(
 payload: T,
 output: OutputDeclaration | undefined,
 options: ProjectOptions = {},
): ProjectResult<T> {
 const secrets = scrubSecrets(payload, output);
 const projection: Projection = {
  strip: new Set(options.stripKinds ?? []),
  dropInternal: options.dropInternal === true,
  allowlist: options.allowlist === true,
 };
 if (projection.strip.size === 0 && !projection.dropInternal && !projection.allowlist) {
  return { projected: secrets.scrubbed, stripped: {}, internalDropped: 0, undeclaredDropped: 0, secrets: secrets.count };
 }
 const rules = output?.rules ?? [];
 assertRootedRules(rules);
 const walk: Walk = {
  rules,
  projection,
  removals: { stripped: {}, internalDropped: 0, undeclaredDropped: 0, total: 0 },
 };
 const projected = projectNode(secrets.scrubbed, walk, '', undefined, true);
 return {
  projected: projected as T,
  stripped: walk.removals.stripped,
  internalDropped: walk.removals.internalDropped,
  undeclaredDropped: walk.removals.undeclaredDropped,
  secrets: secrets.count,
 };
}

/**
 * Walks a value for the projector. checkDeclared is false beneath a field or table-named key: the gate never walked
 * there, so the projector does not count undeclared paths there, but it still strips content at any depth.
 */
function projectNode(
 value: unknown,
 walk: Walk,
 path: string,
 resource: string | undefined,
 checkDeclared: boolean,
): unknown {
 if (value === null || value === undefined) return value;
 if (Array.isArray(value)) {
  const itemPath = path ? `${path}[]` : '[]';
  const itemResource =
   findResourceForPath(walk.rules, itemPath) ?? findResourceForPath(walk.rules, path) ?? resource;
  return value.map((item) => projectNode(item, walk, itemPath, itemResource, checkDeclared));
 }
 if (typeof value === 'object') return projectObject(value as Record<string, unknown>, walk, path, resource, checkDeclared);
 if (typeof value === 'string') return projectString(value, walk, path, resource, checkDeclared);
 return value;
}

function projectObject(
 obj: Record<string, unknown>,
 walk: Walk,
 path: string,
 resource: string | undefined,
 checkDeclared: boolean,
): Record<string, unknown> {
 const objResource = findResourceForPath(walk.rules, path) ?? resource;
 const result: Record<string, unknown> = {};
 for (const [key, child] of Object.entries(obj)) {
  const propPath = path ? `${path}.${key}` : key;
  const declaration = keyDeclaration(walk.rules, NS_RESOURCE_FIELDS, propPath, objResource, key);
  const fieldClass = declaration.fieldRule ?? declaration.tableField;
  if (fieldClass?.class === 'internal' && walk.projection.dropInternal) {
   countRemoval(walk.removals, 'internal');
   continue;
  }
  if (fieldClass?.class === 'content' && walk.projection.strip.has(fieldClass.kind)) {
   countRemoval(walk.removals, fieldClass.kind);
   continue;
  }
  const nameKind = Object.hasOwn(UNAMBIGUOUS_CONTENT_NAMES, key) ? UNAMBIGUOUS_CONTENT_NAMES[key] : undefined;
  if (nameKind !== undefined && walk.projection.strip.has(nameKind)) {
   countRemoval(walk.removals, nameKind);
   continue;
  }
  const named = declaration.fieldRule !== undefined || declaration.tableField !== undefined;
  if (walk.projection.allowlist && checkDeclared && !named && !declaration.structural) {
   countRemoval(walk.removals, 'undeclared');
   continue;
  }
  const childResource = findResourceForPath(walk.rules, propPath) ?? objResource;
  result[key] = projectNode(child, walk, propPath, childResource, checkDeclared && !(named && !declaration.structural));
 }
 return result;
}

function projectString(value: string, walk: Walk, path: string, resource: string | undefined, checkDeclared: boolean): string {
 const trimmed = value.trim();
 const looksLikeJson = (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
 if (!looksLikeJson) return value;
 try {
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object') return value;
  const before = walk.removals.total;
  const projected = projectNode(parsed, walk, path, resource, checkDeclared);
  return walk.removals.total > before ? JSON.stringify(projected) : value;
 } catch {
  // Plain text string
  return value;
 }
}

/**
 * The `_withheld` marker for a projection that removed something (spec 3.3): one count per stripped kind, and
 * `undeclared` for the paths the allowlist dropped. Undefined when nothing was removed. The caller adds it to
 * object payloads only.
 */
export function withheldMarker(
 result: Pick<ProjectResult, 'stripped' | 'undeclaredDropped'>,
): Record<string, number> | undefined {
 const marker: Record<string, number> = { ...result.stripped };
 if (result.undeclaredDropped > 0) marker.undeclared = result.undeclaredDropped;
 return Object.keys(marker).length > 0 ? marker : undefined;
}

/**
 * The output declaration of a generated tool whose response resource is known. It has the NetSapiens response
 * wrapper fields, and the resource under `data` and at the root, the shape resolveGeneratedToolOutput uses.
 */
export function resourceDeclaration(resource: string): OutputDeclaration {
 return {
  rules: [
   { path: 'success', field: { class: 'metadata' } },
   { path: 'error', field: { class: 'metadata' } },
   { path: 'message', field: { class: 'metadata' } },
   { path: 'data[]', resource },
   { path: 'data', resource },
   { path: '', resource },
  ],
 };
}
