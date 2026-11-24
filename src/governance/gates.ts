/**
 * The content gates (spec 3.6): what an operation's request and responses carry, judged from the spec, and the
 * review each operation must have. Pure: the caller supplies the facts and the classes, so a test can feed a
 * synthetic operation to each gate and see it fail.
 *
 * An operation is flagged when:
 * - its response carries a field classified as content, a name that is content by name, or non-JSON media;
 * - its response carries a name the response pattern matches that no classified field, setting entry or review
 *   for that operation explains;
 * - its request sends content to a sink with a model that carries content, or names a voicemail destination;
 * - it is a write that names a destination, whatever the destination carries.
 * A flagged operation must be listed, under every kind it carries. A free listing never silences a name the pattern
 * matches: the name must be on the setting whitelist, or reviewed for this operation with a non-empty reason.
 */
import { CONTENT_KIND_ORDER } from './content-operations.js';
import { UNAMBIGUOUS_CONTENT_NAMES } from './scrub.js';
import type { OperationFacts } from './spec-walk.js';
import type { ContentKind, FieldClass } from './types.js';

/** Response field names that name content by their shape, matched without regard to case. */
export const RESPONSE_NAME_PATTERN =
  /transcri|summary|sentiment|topics|segments|recording|vcon|file-access-url|thumbnail-url|analysis|dialog|text|body|message|media|attachment|fax/i;

/**
 * Response names the pattern matches that are settings, counts, identifiers or status words, reviewed by name. They carry
 * no content, so the pattern does not flag them. A name here never changes a field's class.
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
  'agent-call-disconnect-reason-text': 'a short reason an agent call ended, such as busy or no answer: a label, not call content',
  'agent-status-message': 'a status line for an agent: a label, not call content',
  'call-disconnect-reason-text': 'a short reason a call ended, such as busy or no answer: a label, not call content',
  'call-fax-codec': 'the fax codec a call negotiated: a setting, not fax content',
  'call-fax-relay-side-a-packet-count': 'a count of fax relay packets on a call: a number, not fax content',
  'call-fax-relay-side-b-packet-count': 'a count of fax relay packets on a call: a number, not fax content',
  'call-intelligence-summary-status': 'the state of the summary job for a transcription: a status word, not the summary',
  'call-recording-status': 'the recording status of a call, recorded or not: a status word, not recording content',
  'connection-block-media-in-sip-180-ringing': 'a SIP connection setting about media during ringing: a switch, not content',
  'error-message': 'the error text of a failed request: a status line, not record content',
  'fax-id': 'an identifier of a fax record: a record ID, not content',
  'file-access-url-expires-datetime': 'the expiry time of a signed file link: a timestamp, not content',
  'limits-max-fax-accounts': 'a limit on fax accounts for a domain: a number, not fax content',
  'music-on-hold-comfort-message-repeat-interval-seconds': 'an interval for comfort messages on hold: a number, not content',
  'phonenumber-fax': "a contact's fax number: an address, not fax content",
  'queue-call-disconnect-reason-text': 'a short reason a queued call ended, such as busy or no answer: a label, not call content',
  'recording-server-id': 'an identifier of a recording server: a record ID, not content',
  'schedule-run-immediately': 'a switch that runs a CDR export schedule now: a setting, not content',
  'source-recording-server-id': 'an identifier of the recording server a sync came from: a record ID, not content',
  'status-message': 'a status line for an agent or a queue: a label, not call content',
  'text-to-speech-gender': 'the gender of a text-to-speech voice: a setting, not content',
  'text-to-speech-language': 'the language a text-to-speech voice reads in: a setting, not content',
  'text-to-speech-name': 'the name of a text-to-speech voice: a setting, not content',
  'text-to-speech-sub-type': 'the sub type of a text-to-speech voice: a setting, not content',
  'text-to-speech-type': 'the type of a text-to-speech voice: a setting, not content',
  'text-to-speech-voice-id': 'the text-to-speech voice an announcement uses: a setting, not content',
  'voicemail-recording-started-datetime': 'the time a voicemail recording started: a timestamp, not content',
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

/** A reason that says what a destination receives. A free listing that silences a destination write must carry one. */
export const RECEIVES_PATTERN = /\breceiv/i;

/**
 * Name words that name where something is sent: an address, a host or server, a path, a bucket, a participant, a
 * recipient, a callback, a webhook, an endpoint, a target, a forward, a copy or notify list, an account, an integration,
 * credentials, a member, a push registration, a phone number, a responder, or an agent that receives queued conversations.
 * A word matches in its own form and without a plural s, so "address" and "addresses" both match.
 */
const DESTINATION_TOKENS: ReadonlySet<string> = new Set([
  'url',
  'uri',
  'host',
  'hostname',
  'ip',
  'path',
  'email',
  'smtp',
  'participant',
  'recipient',
  'bucket',
  'server',
  'callback',
  'webhook',
  'endpoint',
  'target',
  'forward',
  'forwardto',
  'to',
  'cc',
  'bcc',
  'cclist',
  'notify',
  'account',
  'integration',
  'credentials',
  'address',
  'member',
  'push',
  'phonenumber',
  'responder',
  'agent',
]);

/** Word runs that name a destination together: a push device's token, and its address of record. */
const DESTINATION_PHRASES: readonly (readonly string[])[] = [
  ['device', 'token'],
  ['device', 'aor'],
];

/** The lower-cased words of a field name, split at separators and camel-case joins. */
function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split(/[-_.\s]+/)
    .filter((word) => word !== '');
}

/** Whether the words contain the phrase as a run, in order. */
function containsRun(words: readonly string[], phrase: readonly string[]): boolean {
  return words.some((_, start) => phrase.every((word, offset) => words[start + offset] === word));
}

/**
 * Whether a field name names a destination: one of its words, in its own form or without a plural s, is a destination
 * word or begins with dest, or its words contain a destination phrase.
 */
export function isDestinationName(name: string): boolean {
  const words = wordsOf(name);
  const forms = words.flatMap((word) => (word.endsWith('s') ? [word, word.slice(0, -1)] : [word]));
  if (forms.some((form) => DESTINATION_TOKENS.has(form) || form.startsWith('dest'))) return true;
  const singular = words.map((word) => (word.endsWith('s') ? word.slice(0, -1) : word));
  return DESTINATION_PHRASES.some((phrase) => containsRun(singular, phrase));
}

export interface GateRequirement {
  /** The kinds the operation returns or transmits, in decision order. */
  readonly kinds: readonly ContentKind[];
  /** Whether a gate requires the operation to be listed. */
  readonly flagged: boolean;
  /** Why the operation is flagged, phrased for a violation message. Undefined when it is not flagged. */
  readonly reason: string | undefined;
  /** Response names the pattern matches that no class, setting entry or review for the operation explains. */
  readonly unreviewedNames: readonly string[];
  /** The request names that name a destination: body names, and query names for a write. Empty when none does. */
  readonly destinations: readonly string[];
}

function orderedKinds(kinds: Iterable<ContentKind>): ContentKind[] {
  const unique = new Set(kinds);
  return CONTENT_KIND_ORDER.filter((kind) => unique.has(kind));
}

function unambiguousKind(name: string): ContentKind | undefined {
  return Object.hasOwn(UNAMBIGUOUS_CONTENT_NAMES, name) ? UNAMBIGUOUS_CONTENT_NAMES[name] : undefined;
}

/**
 * Whether a response name the pattern matches is explained: a table class other than metadata (content, internal,
 * secret or record ID, which only a review sets), a whitelisted setting, or a non-empty review for this operation.
 */
function isReviewed(name: string, cls: FieldClass | undefined, reviewedNames: Readonly<Record<string, string>>): boolean {
  if (cls !== undefined && cls.class !== 'metadata') return true;
  if (Object.hasOwn(REVIEWED_SETTING_NAMES, name)) return true;
  return Object.hasOwn(reviewedNames, name) && reviewedNames[name].trim() !== '';
}

/** Gate (b): the response's content, judged by the resource table its operation maps to, and its unexplained names. */
export function responseRequirement(
  facts: OperationFacts,
  table: Readonly<Record<string, FieldClass>> | undefined,
  reviewedNames: Readonly<Record<string, string>>,
): GateRequirement {
  const kinds = new Set<ContentKind>();
  const unreviewed: string[] = [];
  for (const name of facts.responseNames) {
    const cls = table !== undefined && Object.hasOwn(table, name) ? table[name] : undefined;
    if (cls?.class === 'content') {
      kinds.add(cls.kind);
      for (const also of cls.alsoKinds ?? []) kinds.add(also);
    }
    const unambiguous = unambiguousKind(name);
    if (unambiguous !== undefined) {
      kinds.add(unambiguous);
      continue;
    }
    if (RESPONSE_NAME_PATTERN.test(name) && !isReviewed(name, cls, reviewedNames)) unreviewed.push(name);
  }
  unreviewed.sort();
  const ordered = orderedKinds(kinds);
  const parts = [
    ordered.length > 0 ? `carries ${ordered.join(', ')}` : undefined,
    unreviewed.length > 0 ? `has response fields no review explains (${unreviewed.join(', ')})` : undefined,
    facts.responseMedia.size > 0 ? 'returns non-JSON media' : undefined,
  ].filter((part): part is string => part !== undefined);
  return {
    kinds: ordered,
    flagged: parts.length > 0,
    reason: parts.length > 0 ? parts.join('; ') : undefined,
    unreviewedNames: unreviewed,
    destinations: [],
  };
}

/** Gates (c) and (a): a request that sends content to a sink, a voicemail destination, and a write that names a destination. */
export function requestRequirement(facts: OperationFacts): GateRequirement {
  const sinks = [...facts.requestNames].some((name) => SINK_NAMES.has(name));
  const modelKinds = new Set<ContentKind>();
  for (const value of facts.requestEnumValues) {
    if (!Object.hasOwn(MODEL_KINDS, value)) continue;
    for (const kind of MODEL_KINDS[value]) modelKinds.add(kind);
  }
  const transmits = sinks && modelKinds.size > 0;
  const voicemailDestination = [...facts.requestNames].some(isVoicemailDestination);
  const destinations = facts.writes ? [...new Set([...facts.bodyNames, ...facts.queryNames])].filter(isDestinationName).sort() : [];
  const kinds = new Set(modelKinds);
  if (voicemailDestination) kinds.add('voicemail');
  const parts = [
    transmits ? `transmits ${orderedKinds(modelKinds).join(', ')}` : undefined,
    voicemailDestination ? 'sets a voicemail destination' : undefined,
    destinations.length > 0 ? `writes a destination (${destinations.join(', ')})` : undefined,
  ].filter((part): part is string => part !== undefined);
  return {
    kinds: orderedKinds(kinds),
    flagged: parts.length > 0,
    reason: parts.length > 0 ? parts.join('; ') : undefined,
    unreviewedNames: [],
    destinations,
  };
}

/** Every gate together: the kinds an operation must be listed under, why it is flagged, and its unexplained names. */
export function operationRequirement(
  facts: OperationFacts,
  table: Readonly<Record<string, FieldClass>> | undefined,
  reviewedNames: Readonly<Record<string, string>>,
): GateRequirement {
  const response = responseRequirement(facts, table, reviewedNames);
  const request = requestRequirement(facts);
  const reasons = [response.reason, request.reason].filter((reason): reason is string => reason !== undefined);
  return {
    kinds: orderedKinds([...response.kinds, ...request.kinds]),
    flagged: response.flagged || request.flagged,
    reason: reasons.length > 0 ? reasons.join('; ') : undefined,
    unreviewedNames: response.unreviewedNames,
    destinations: request.destinations,
  };
}

/**
 * The violations of one operation. An unlisted flagged operation is one violation. A listed one violates when it
 * misses a kind it carries, or when a name the pattern matches is not reviewed for it. 'unreviewed' lists every kind,
 * so it covers any flagged operation. A free listing of a destination write must give a reason that says what the
 * destination receives (RECEIVES_PATTERN), since no kind shows that the destination carries no content. An empty list
 * means the operation is covered.
 */
export function operationViolations(
  key: string,
  facts: OperationFacts,
  table: Readonly<Record<string, FieldClass>> | undefined,
  listed: readonly ContentKind[] | 'unreviewed' | undefined,
  reviewedNames: Readonly<Record<string, string>>,
  freeReason?: string,
): string[] {
  if (listed === 'unreviewed') return [];
  const requirement = operationRequirement(facts, table, reviewedNames);
  if (!requirement.flagged) return [];
  if (listed === undefined) return [`${key}: unlisted, ${requirement.reason ?? 'flagged'}`];
  const violations: string[] = [];
  if (requirement.unreviewedNames.length > 0) {
    violations.push(`${key}: response names not reviewed for this operation (${requirement.unreviewedNames.join(', ')})`);
  }
  const missing = requirement.kinds.filter((kind) => !listed.includes(kind));
  if (missing.length > 0) violations.push(`${key}: listed kinds [${listed.join(', ')}] miss ${missing.join(', ')}`);
  const receivesDestination = freeReason !== undefined && RECEIVES_PATTERN.test(freeReason);
  if (listed.length === 0 && requirement.destinations.length > 0 && !receivesDestination) {
    violations.push(`${key}: free listing silences a destination write (${requirement.destinations.join(', ')}) without saying what the destination receives`);
  }
  return violations;
}
