import type { OutputDeclaration, ScrubResult, FieldRule } from './types.js';
import { NS_RESOURCE_FIELDS } from './ns-fields.generated.js';

/**
 * Known unambiguous credential field names from NetSapiens schemas that must
 * always be scrubbed when encountered at any depth.
 */
const UNAMBIGUOUS_SECRET_NAMES: Record<string, true> = {
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
