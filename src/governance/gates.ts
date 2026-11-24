/**
 * The content gates (spec 3.6): what an operation's request and responses carry, judged from the spec, and the
 * review each operation must have. Pure: the caller supplies the facts and the classes, so a test can feed a
 * synthetic operation to each gate and see it fail.
 *
 * An operation is flagged when its response carries a classified content field, a field the response pattern names
 * and is not reviewed as a setting, or non-JSON media; when its request names a sink and a model that carries
 * content; or when its request names a voicemail destination. A flagged operation must be listed, under every kind it
 * carries.
 */
import { CONTENT_KIND_ORDER } from './content-operations.js';
import { UNAMBIGUOUS_CONTENT_NAMES } from './scrub.js';
import type { OperationFacts } from './spec-walk.js';
import type { ContentKind, FieldClass } from './types.js';

/** Response field names that name content by their shape. A name matching it must be reviewed. */
export const RESPONSE_NAME_PATTERN = /transcri|summary|sentiment|topics|segments|recording|vcon|file-access-url|thumbnail-url|analysis|dialog/;

/**
 * Response field names the pattern matches that are settings, counts, identifiers or plumbing, reviewed by name. They
 * carry no content, so the pattern does not flag them. Any other name the pattern matches must be reviewed by listing
 * the operation that returns it. A name here never changes a field's class: a classified field still carries its kind.
 */
export const REVIEWED_SETTING_NAMES: Readonly<Record<string, string>> = {
  'analysis-denylist': 'a user-interface setting for call analysis: a list of rules, not analysis output',
  'analysis-rule-policy': 'a user-interface setting for call analysis: a policy, not analysis output',
  'analysis-ruleset-fingerprint': 'a user-interface setting for call analysis: a version identifier, not analysis output',
  'analysis-settings': 'a user-interface setting for call analysis: switches, not analysis output',
  'call-recordings-hide-from-others-enabled': 'a user switch that hides call recordings from others; no recording content',
  'connection-sip-get-new-dialog-destination-from': 'a SIP connection setting about the dialog destination; no content',
  'count-users-configured-voicemail-transcription-google': 'a billing count of users with a transcription provider; no transcript',
  'count-users-configured-voicemail-transcription-mutare': 'a billing count of users with a transcription provider; no transcript',
  'count-users-configured-voicemail-transcription-nuance': 'a billing count of users with a transcription provider; no transcript',
  'count-users-configured-voicemail-transcription-voicebase': 'a billing count of users with a transcription provider; no transcript',
  'device-level-call-recording-enabled': 'a device switch that enables call recording; no recording content',
  'meeting-recording-enabled': 'a meeting switch that enables recording; no recording content',
  'recording-configuration': 'a domain switch that enables call recording; no recording content',
  'voicemail-transcription-enabled': 'a user or domain switch that enables voicemail transcription; no transcript',
};

/** Request fields that send data out: a URL to post to, an address, a copy list, a forward, or an owner. */
export const SINK_NAMES: ReadonlySet<string> = new Set(['post-url', 'url', 'email', 'cclist', 'forward', 'owner']);

/** The content a model enum value transmits. A cdr carries its call intelligence, so it is conservative. */
const MODEL_KINDS: Readonly<Record<string, readonly ContentKind[]>> = {
  message: ['sms_text'],
  messagesession: ['sms_text'],
  voicemail: ['voicemail'],
  cdr: ['transcript', 'ai_summary'],
};

/** Request fields that name where voicemail or its reminders are delivered, or where forwarding goes. */
export const DESTINATION_PATTERN =
  /^(email-send-alert-new-voicemail-cc-list-csv|voicemail-forward-new-destination|vmail_f(wd|rd)_to|voicemail-reminder-.*(address|phonenumber).*)$/;

/** Whether a request field names a voicemail destination. */
export function isVoicemailDestination(name: string): boolean {
  return DESTINATION_PATTERN.test(name);
}

export interface GateRequirement {
  /** The kinds the operation returns or transmits, in decision order. */
  readonly kinds: readonly ContentKind[];
  /** Whether a gate requires the operation to be listed. */
  readonly flagged: boolean;
  /** Why the operation is flagged, phrased for a violation message. Undefined when it is not flagged. */
  readonly reason: string | undefined;
}

function orderedKinds(kinds: Iterable<ContentKind>): ContentKind[] {
  const unique = new Set(kinds);
  return CONTENT_KIND_ORDER.filter((kind) => unique.has(kind));
}

function unambiguousKind(name: string): ContentKind | undefined {
  return Object.hasOwn(UNAMBIGUOUS_CONTENT_NAMES, name) ? UNAMBIGUOUS_CONTENT_NAMES[name] : undefined;
}

/** Gate (b): the response's content, judged by the resource table its operation maps to. */
export function responseRequirement(facts: OperationFacts, table: Readonly<Record<string, FieldClass>> | undefined): GateRequirement {
  const kinds = new Set<ContentKind>();
  let named = false;
  for (const name of facts.responseNames) {
    const cls = table !== undefined && Object.hasOwn(table, name) ? table[name] : undefined;
    if (cls?.class === 'content') {
      kinds.add(cls.kind);
      for (const also of cls.alsoKinds ?? []) kinds.add(also);
    }
    const unambiguous = unambiguousKind(name);
    if (unambiguous !== undefined) kinds.add(unambiguous);
    if (RESPONSE_NAME_PATTERN.test(name) && !Object.hasOwn(REVIEWED_SETTING_NAMES, name)) named = true;
  }
  const ordered = orderedKinds(kinds);
  const media = facts.responseMedia.size > 0;
  const parts = [
    ordered.length > 0 ? `carries ${ordered.join(', ')}` : undefined,
    named && ordered.length === 0 ? 'has a response field the content pattern names' : undefined,
    media ? 'returns non-JSON media' : undefined,
  ].filter((part): part is string => part !== undefined);
  return { kinds: ordered, flagged: parts.length > 0, reason: parts.length > 0 ? parts.join('; ') : undefined };
}

/** Gate (c): a request that sends content to a sink, and a voicemail destination. */
export function requestRequirement(facts: OperationFacts): GateRequirement {
  const sinks = [...facts.requestNames].filter((name) => SINK_NAMES.has(name));
  const kinds = new Set<ContentKind>();
  for (const value of facts.requestEnumValues) {
    if (!Object.hasOwn(MODEL_KINDS, value)) continue;
    for (const kind of MODEL_KINDS[value]) kinds.add(kind);
  }
  const transmits = sinks.length > 0 && kinds.size > 0;
  const destination = [...facts.requestNames].some(isVoicemailDestination);
  if (destination) kinds.add('voicemail');
  const ordered = orderedKinds(kinds);
  const parts = [
    transmits ? `transmits ${ordered.join(', ')}` : undefined,
    destination ? 'sets a voicemail destination' : undefined,
  ].filter((part): part is string => part !== undefined);
  return { kinds: ordered, flagged: parts.length > 0, reason: parts.length > 0 ? parts.join('; ') : undefined };
}

/** Both gates together: the kinds an operation must be listed under, and why it is flagged. */
export function operationRequirement(facts: OperationFacts, table: Readonly<Record<string, FieldClass>> | undefined): GateRequirement {
  const response = responseRequirement(facts, table);
  const request = requestRequirement(facts);
  const reasons = [response.reason, request.reason].filter((reason): reason is string => reason !== undefined);
  return {
    kinds: orderedKinds([...response.kinds, ...request.kinds]),
    flagged: response.flagged || request.flagged,
    reason: reasons.length > 0 ? reasons.join('; ') : undefined,
  };
}

/**
 * The violations of one operation: an unlisted flagged operation, or a listing that misses a kind it carries. An
 * empty list means the operation is covered. 'unreviewed' lists every kind, so it covers any flagged operation.
 */
export function operationViolations(
  key: string,
  facts: OperationFacts,
  table: Readonly<Record<string, FieldClass>> | undefined,
  listed: readonly ContentKind[] | 'unreviewed' | undefined,
): string[] {
  const requirement = operationRequirement(facts, table);
  if (!requirement.flagged || listed === 'unreviewed') return [];
  if (listed === undefined) return [`${key}: unlisted, ${requirement.reason ?? 'flagged'}`];
  const missing = requirement.kinds.filter((kind) => !listed.includes(kind));
  return missing.length > 0 ? [`${key}: listed kinds [${listed.join(', ')}] miss ${missing.join(', ')}`] : [];
}
