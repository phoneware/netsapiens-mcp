/**
 * Content operations (spec 3.6): which NetSapiens operations return or transmit a content kind, and
 * which operations have been reviewed as carrying none.
 *
 * Keys are normalizeOperationKey(method, pathTemplate) for v2 and "v1:<object>:<action>" for v1Call.
 * An operation is a content operation of kind K when its primary purpose is to return or transmit K.
 * A record list whose content fields are all classified is not one: its fields are stripped by the
 * output projection. A list that returns content the field table does not classify is one, so the
 * kind can refuse it. The projection cannot strip what it cannot classify.
 *
 * Every v2 or v1 operation whose path or v1 object matches CONTENT_GATE must sit in exactly one of
 * CONTENT_OPERATIONS (for any kind), UNREVIEWED_CONTENT_OPERATIONS or REVIEWED_CONTENT_FREE. The gate
 * test fails on an operation nobody has reviewed and on an entry naming an operation that no longer
 * exists. Changing an entry changes the @content groups; the group snapshot shows the effect.
 */
import type { ContentKind } from './types.js';

/** Paths (v2) and objects (v1) that need a review entry. */
export const CONTENT_GATE =
  /record|transcri|vcon|audio|voicemail|vmail|message|msg|sms|mms|fax|insight|intelligence|summary|sentiment|media|greeting|moh|meeting|conference|export|sipflow|cradle|trace/i;

/** Call recordings: the audio of a call or of one meeting instance, with a signed link that plays it. */
const RECORDING_OPERATIONS = [
  'GET /domains/{}/recordings/{}',
  'GET /domains/{}/users/{}/recordings/{}',
  'GET /recordings/play',
  // Playback token for the recording of one meeting instance.
  'GET /domains/{}/users/{}/meetings/{}/sfu',
  // v1 audio files are read as call recordings (spec 3.6). That is conservative for greetings.
  'v1:audio:play',
  'v1:audio:read',
  'v1:recording:read',
] as const;

/** vCon documents: one response carries the call's recording, transcript and summary. */
const VCON_OPERATIONS = [
  'GET /domains/{}/cdrs/{}/vcon',
  'GET /domains/{}/users/{}/vcon/{}',
  'GET /domains/{}/vcon/{}',
] as const;

/** Transcriptions: the transcript, with the AI summary and topics that the same response carries. */
const TRANSCRIPTION_OPERATIONS = ['GET /domains/{}/transcriptions'] as const;

/**
 * CDR schedule exports at all three scopes: list, read (which hands out a fresh signed link) and
 * download. Conservatively transcript and summary, as v1 cdrexport is.
 */
const CDR_EXPORT_OPERATIONS = [
  'GET /domains/{}/schedule/{}/exports',
  'GET /domains/{}/schedule/{}/exports/{}',
  'GET /domains/{}/schedule/{}/exports/{}/download',
  'GET /resellers/{}/schedule/{}/exports',
  'GET /resellers/{}/schedule/{}/exports/{}',
  'GET /resellers/{}/schedule/{}/exports/{}/download',
  'GET /schedule/{}/exports',
  'GET /schedule/{}/exports/{}',
  'GET /schedule/{}/exports/{}/download',
] as const;

/**
 * Voicemail messages: list, read, play, delete, save and forward. The list is voicemail rather than a
 * stripped record list because its audio link (Audiofile.file-access-url) is not classified.
 */
const VOICEMAIL_OPERATIONS = [
  'GET /domains/{}/users/{}/voicemails/{}',
  'GET /domains/{}/users/{}/voicemails/{}/{}',
  'GET /domains/{}/users/{}/voicemails/{}/{}/play',
  'DELETE /domains/{}/users/{}/voicemails/{}/{}',
  'PATCH /domains/{}/users/{}/voicemails/{}/{}/save',
  'PATCH /domains/{}/users/{}/voicemails/{}/{}/forward',
] as const;

/**
 * Message bodies and sends. Message-session rows are not here: they are record lists whose last
 * message is stripped by the Messagesession field class.
 */
const MESSAGE_BODY_OPERATIONS = [
  'GET /domains/{}/users/{}/messagesessions/{}/messages',
  'POST /domains/{}/users/{}/messagesessions/{}/messages',
  'POST /domains/{}/users/{}/messages',
  'POST /domains/{}/users/{}/messagesessions',
] as const;

/**
 * Fax pages: documents, thumbnails, sends and the rendered cover page that a send attaches. The list
 * and read are fax_page because their Fax records carry signed document links the field table does
 * not classify.
 */
const FAX_OPERATIONS = [
  'GET /domains/{}/users/{}/faxes',
  'GET /domains/{}/users/{}/faxes/{}',
  'GET /domains/{}/users/{}/faxes/{}/play',
  'GET /domains/{}/users/{}/faxes/{}/thumbnail',
  'POST /domains/{}/users/{}/faxes',
  'POST /domains/{}/users/{}/fax/cover-page/preview',
] as const;

/** A static membership table: each listed key maps to true. Read it with isListed. */
function lookup(keys: readonly string[]): Readonly<Record<string, true>> {
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, true] as const)));
}

/** Whether a key is listed in a membership table. */
function isListed(table: Readonly<Record<string, true>>, key: string): boolean {
  return Object.hasOwn(table, key);
}

/** Each operation a kind's set lists. A key may appear under several kinds. */
export const CONTENT_OPERATIONS: Readonly<Record<ContentKind, Readonly<Record<string, true>>>> = {
  call_recording: lookup([...RECORDING_OPERATIONS, ...VCON_OPERATIONS]),
  transcript: lookup([
    ...TRANSCRIPTION_OPERATIONS,
    ...VCON_OPERATIONS,
    ...CDR_EXPORT_OPERATIONS,
    // Single voicemail read: the message and its transcript.
    'GET /domains/{}/users/{}/voicemails/{}/{}',
    'v1:cdrexport:download',
    'v1:cdrexport:read',
  ]),
  voicemail: lookup([...VOICEMAIL_OPERATIONS, 'v1:conversation:read']),
  sms_text: lookup([
    ...MESSAGE_BODY_OPERATIONS,
    'v1:email:create',
    'v1:conversation:read',
    'v1:message:create',
    'v1:message:read',
    'v1:message:read_media',
  ]),
  ai_summary: lookup([
    ...TRANSCRIPTION_OPERATIONS,
    ...VCON_OPERATIONS,
    ...CDR_EXPORT_OPERATIONS,
    'v1:cdrexport:download',
    'v1:cdrexport:read',
  ]),
  fax_page: lookup([
    ...FAX_OPERATIONS,
    // Plays a voicemail-folder item, which may be a fax image.
    'GET /domains/{}/users/{}/voicemails/{}/{}/play',
  ]),
};

/**
 * iNSight reads. Not reviewed (spec 3.6), so they count as every kind and any denied kind refuses them.
 */
export const UNREVIEWED_CONTENT_OPERATIONS: Readonly<Record<string, true>> = lookup([
  'GET /insight/active_alerts',
  'GET /insight/{}',
]);

/**
 * Gated operations reviewed as carrying no content kind. Records that embed classified content fields
 * are here too: the projection strips those fields.
 */
export const REVIEWED_CONTENT_FREE: Readonly<Record<string, true>> = lookup([
  // SIP and call traces: not one of the six kinds. Free text is out of reach of field classes (spec 3.6).
  'DELETE /domains/{}/sipflow/share/{}',
  'DELETE /sipflow/share/{}',
  'GET /domains/{}/cdrs/{}/cradle2grave',
  'GET /domains/{}/cdrs/{}/sipflow',
  'GET /domains/{}/sipflow/export',
  'GET /domains/{}/sipflow/{}',
  'GET /sipflow',
  'GET /sipflow/download/{k}.txt',
  'GET /sipflow/events',
  'GET /sipflow/export',
  'GET /sipflow/{}',
  'POST /domains/{}/cdrs/{}/sipflow/store',
  'POST /domains/{}/sipflow/export',
  'POST /domains/{}/sipflow/{}/store',
  'POST /sipflow/event',
  'POST /sipflow/export',
  'POST /sipflow/{}/store',
  // Conferences, meetings and video: schedules, participants, events and join tokens.
  'DELETE /domains/{}/conferences/{}',
  'DELETE /domains/{}/conferences/{}/participants/{}',
  'DELETE /domains/{}/users/{}/meetings/{}',
  'GET /domains/{}/conferences',
  'GET /domains/{}/conferences/count',
  'GET /domains/{}/conferences/list',
  'GET /domains/{}/conferences/{}',
  'GET /domains/{}/conferences/{}/cdr',
  'GET /domains/{}/conferences/{}/participants',
  'GET /domains/{}/conferences/{}/participants/list',
  'GET /domains/{}/conferences/{}/participants/{}',
  'GET /domains/{}/users/{}/meetings',
  'GET /domains/{}/users/{}/meetings/count',
  'GET /domains/{}/users/{}/meetings/list',
  'GET /domains/{}/users/{}/meetings/{}',
  'GET /domains/{}/users/{}/meetings/{}/attendee/{}',
  'GET /domains/{}/users/{}/meetings/{}/count',
  'GET /domains/{}/users/{}/meetings/{}/instance/{}',
  'GET /domains/{}/users/{}/meetings/{}/instance/{}/log',
  'GET /domains/{}/users/{}/video/conference',
  'GET /meetings/register/{}',
  'POST /domains/{}/conferences',
  'POST /domains/{}/conferences/{}/participants',
  'POST /domains/{}/users/{}/meetings',
  'POST /domains/{}/users/{}/meetings/getId',
  'POST /domains/{}/users/{}/meetings/{}',
  'POST /domains/{}/users/{}/meetings/{}/instance/{}/log',
  'POST /domains/{}/users/{}/meetings/{}/sfu',
  'POST /domains/{}/users/{}/video/conference',
  'POST /meetings/register/{}',
  'PUT /domains/{}/conferences/{}',
  'PUT /domains/{}/conferences/{}/participants/{}',
  'PUT /domains/{}/users/{}/meetings/{}',
  'PUT /domains/{}/users/{}/meetings/{}/attendee/{}',
  // Recording settings: configuration, servers, storage and recording entries (which addresses of record
  // are recorded). These are settings, not recordings.
  'DELETE /domains/{}/recording-storage/{}',
  'DELETE /recordings/archive-configs/{}/{}/{}',
  'DELETE /recordings/config/{}',
  'DELETE /recordings/entries',
  'DELETE /recordings/nmc-config/{}',
  'DELETE /recordings/servers/{}',
  'DELETE /recordings/servers/{}/entries',
  'DELETE /recordings/servers/{}/entries/sync/{}',
  'GET /domains/{}/recording-storage',
  'GET /domains/{}/recording-storage/{}',
  'GET /recordings/archive-configs',
  'GET /recordings/archive-configs/{}/{}/{}',
  'GET /recordings/config',
  'GET /recordings/config/servers',
  'GET /recordings/config/{}',
  'GET /recordings/coreservers',
  'GET /recordings/coreservers/{}',
  'GET /recordings/entries',
  'GET /recordings/entries/count',
  'GET /recordings/nmc-config',
  'GET /recordings/nmc-config/servers',
  'GET /recordings/nmc-config/{}',
  'GET /recordings/servers',
  'GET /recordings/servers/count',
  'GET /recordings/servers/{}',
  'GET /recordings/servers/{}/entries',
  'GET /recordings/servers/{}/entries/count',
  'GET /recordings/servers/{}/entries/sync/{}',
  'GET /recordings/storage',
  'POST /domains/{}/recording-storage',
  'POST /recordings/archive-configs',
  'POST /recordings/config',
  'POST /recordings/entries',
  'POST /recordings/nmc-config',
  'POST /recordings/servers',
  'POST /recordings/servers/{}/entries',
  'POST /recordings/servers/{}/entries/sync',
  'PUT /domains/{}/recording-storage/{}',
  'PUT /recordings/archive-configs/{}/{}/{}',
  'PUT /recordings/config/{}',
  'PUT /recordings/coreservers/{}',
  'PUT /recordings/entries',
  'PUT /recordings/nmc-config/{}',
  'PUT /recordings/servers/{}',
  'PUT /recordings/servers/{}/entries',
  // Fax setup and fax deletion: numbers, vendors, cover-page templates and deletes. Fax documents are above.
  'DELETE /domains/{}/fax/cover-page',
  'DELETE /domains/{}/faxnumbers/{}',
  'DELETE /domains/{}/users/{}/fax/cover-page',
  'DELETE /domains/{}/users/{}/faxes',
  'DELETE /domains/{}/users/{}/faxes/{}',
  'DELETE /fax/cover-page',
  'DELETE /resellers/{}/fax/cover-page',
  'GET /domains/{}/fax/cover-page',
  'GET /domains/{}/fax/cover-page/file',
  'GET /domains/{}/fax/vendor',
  'GET /domains/{}/faxnumbers',
  'GET /domains/{}/faxnumbers/{}',
  'GET /domains/{}/users/{}/fax/cover-page',
  'GET /domains/{}/users/{}/fax/cover-page/file',
  'GET /domains/{}/users/{}/faxnumbers',
  'GET /domains/{}/users/{}/faxnumbers/{}',
  'GET /fax/cover-page',
  'GET /fax/cover-page/file',
  'GET /fax/vendors',
  'GET /resellers/{}/fax/cover-page',
  'GET /resellers/{}/fax/cover-page/file',
  'POST /domains/{}/fax/cover-page',
  'POST /domains/{}/faxnumbers',
  'POST /domains/{}/users/{}/fax/cover-page',
  'POST /fax/cover-page',
  'POST /resellers/{}/fax/cover-page',
  'PUT /domains/{}/fax/cover-page',
  'PUT /domains/{}/faxnumbers/{}',
  'PUT /domains/{}/users/{}/fax/cover-page',
  'PUT /domains/{}/users/{}/faxnumbers/{}',
  'PUT /fax/cover-page',
  'PUT /resellers/{}/fax/cover-page',
  // SMS setup and message-session records. Session rows carry the last message, which is stripped.
  'DELETE /domains/{}/inboxes/{}/smsnumbers/{}',
  'DELETE /domains/{}/smsblocks/{}',
  'DELETE /domains/{}/smsnumbers/{}',
  'DELETE /domains/{}/users/{}/messagesessions/{}',
  'DELETE /smscarriers/{}',
  'GET /domains/{}/messagesessions',
  'GET /domains/{}/smsblocks',
  'GET /domains/{}/smsblocks/{}',
  'GET /domains/{}/smsnumbers',
  'GET /domains/{}/smsnumbers/count',
  'GET /domains/{}/smsnumbers/{}',
  'GET /domains/{}/users/{}/messagesessions',
  'GET /domains/{}/users/{}/messagesessions/count',
  'GET /domains/{}/users/{}/messagesessions/{}',
  'GET /domains/{}/users/{}/smsnumbers',
  'GET /domains/{}/users/{}/smsnumbers/count',
  'GET /smsblocks',
  'GET /smscarriers',
  'GET /smscarriers/{}',
  'GET /smsnumbers',
  'POST /domains/{}/inboxes/{}/smsnumbers',
  'POST /domains/{}/smsblocks',
  'POST /domains/{}/smsnumbers',
  'POST /domains/{}/users/{}/smsblocks',
  'POST /smscarriers',
  'PUT /domains/{}/smsblocks/{}',
  'PUT /domains/{}/smsnumbers/{}',
  'PUT /domains/{}/users/{}/messagesessions/{}',
  'PUT /domains/{}/users/{}/messagesessions/{}/accept',
  'PUT /domains/{}/users/{}/messagesessions/{}/leave',
  'PUT /smscarriers/{}',
  // Greetings, music on hold and hold messages: audio an administrator uploads. Not one of the six kinds.
  'DELETE /domains/{}/moh/{}',
  'DELETE /domains/{}/msg/{}',
  'DELETE /domains/{}/users/{}/greetings/{}',
  'DELETE /domains/{}/users/{}/moh/{}',
  'DELETE /domains/{}/users/{}/msg/{}',
  'GET /domains/{}/moh',
  'GET /domains/{}/moh/count',
  'GET /domains/{}/moh/{}',
  'GET /domains/{}/moh/{}/play',
  'GET /domains/{}/msg',
  'GET /domains/{}/msg/count',
  'GET /domains/{}/msg/{}',
  'GET /domains/{}/msg/{}/play',
  'GET /domains/{}/users/{}/greetings',
  'GET /domains/{}/users/{}/greetings/count',
  'GET /domains/{}/users/{}/greetings/{}',
  'GET /domains/{}/users/{}/greetings/{}/play',
  'GET /domains/{}/users/{}/moh',
  'GET /domains/{}/users/{}/moh/count',
  'GET /domains/{}/users/{}/moh/{}',
  'GET /domains/{}/users/{}/moh/{}/play',
  'GET /domains/{}/users/{}/msg',
  'GET /domains/{}/users/{}/msg/count',
  'GET /domains/{}/users/{}/msg/{}',
  'GET /domains/{}/users/{}/msg/{}/play',
  'POST /domains/{}/moh',
  'POST /domains/{}/msg',
  'POST /domains/{}/users/{}/greetings',
  'POST /domains/{}/users/{}/moh',
  'POST /domains/{}/users/{}/msg',
  'PUT /domains/{}/moh/reorder',
  'PUT /domains/{}/moh/{}',
  'PUT /domains/{}/msg/reorder',
  'PUT /domains/{}/msg/{}',
  'PUT /domains/{}/users/{}/greetings/{}',
  'PUT /domains/{}/users/{}/moh/reorder',
  'PUT /domains/{}/users/{}/moh/{}',
  'PUT /domains/{}/users/{}/msg/reorder',
  'PUT /domains/{}/users/{}/msg/{}',
  // Voicemail reminders and counts. Voicemail reads and changes are voicemail above.
  'DELETE /domains/{}/users/{}/vmailnag',
  'GET /domains/{}/users/{}/vmailnag',
  'GET /domains/{}/users/{}/vmailnag/count',
  'GET /domains/{}/users/{}/voicemails/{}/count',
  'POST /domains/{}/users/{}/vmailnag',
  'PUT /domains/{}/users/{}/vmailnag',
  // v1 audio files: counts, deletes, link updates and uploads. Reads and playback are call_recording above.
  'v1:audio:count',
  'v1:audio:delete',
  'v1:audio:link_delete',
  'v1:audio:link_update',
  'v1:audio:update',
  'v1:audio:upload',
  // v1 CDR export schedules: create, update and delete. Reads and downloads are above.
  'v1:cdrexport:create',
  'v1:cdrexport:delete',
  'v1:cdrexport:update',
  // v1 conferences and meetings.
  'v1:conference:count',
  'v1:conference:create',
  'v1:conference:delete',
  'v1:conference:read',
  'v1:conference:update',
  'v1:conferencecdr:read',
  'v1:meeting:count',
  'v1:meeting:create',
  'v1:meeting:delete',
  'v1:meeting:deleteEvents',
  'v1:meeting:logEvent',
  'v1:meeting:read',
  'v1:meeting:readEvents',
  'v1:meeting:update',
  // v1 message deletion and message-session records. v1 has no output mapping, so a session record is not
  // projected: under unclassifiedOutput allow its embedded last message is returned.
  'v1:message:delete',
  'v1:messagesession:accept',
  'v1:messagesession:delete',
  'v1:messagesession:dispatch',
  'v1:messagesession:leave',
  'v1:messagesession:read',
  'v1:messagesession:update',
  // v1 recording settings: enabling, disabling and updating recording records. Reads are above.
  'v1:recording:create',
  'v1:recording:delete',
  'v1:recording:update',
  // v1 SMS numbers.
  'v1:smsnumber:count',
  'v1:smsnumber:create',
  'v1:smsnumber:read',
  'v1:smsnumber:update',
  // v1 SIP trace export.
  'v1:trace:export',
  // v1 voicemail reminders.
  'v1:vmailnag:count',
  'v1:vmailnag:create',
  'v1:vmailnag:delete',
  'v1:vmailnag:read',
  'v1:vmailnag:update',
]);

/** The three sets together, so the gate test and the lookups read one value. */
export interface ContentOperationTable {
  readonly kinds: Readonly<Record<ContentKind, Readonly<Record<string, true>>>>;
  readonly unreviewed: Readonly<Record<string, true>>;
  readonly free: Readonly<Record<string, true>>;
}

export const CONTENT_OPERATION_TABLE: ContentOperationTable = {
  kinds: CONTENT_OPERATIONS,
  unreviewed: UNREVIEWED_CONTENT_OPERATIONS,
  free: REVIEWED_CONTENT_FREE,
};

/** Kinds in the order decisions report them. The type fails to compile when a kind is missing. */
const KIND_ORDER = [
  'call_recording',
  'transcript',
  'voicemail',
  'sms_text',
  'ai_summary',
  'fax_page',
] as const satisfies readonly ContentKind[];

/** Every kind, in the order decisions report them. */
export const CONTENT_KIND_ORDER: readonly ContentKind[] = KIND_ORDER;
type MissingKind = Exclude<ContentKind, (typeof KIND_ORDER)[number]>;
const kindOrderComplete: [MissingKind] extends [never] ? true : never = true;
void kindOrderComplete;

/**
 * What an operation is classified as: the kinds it returns or transmits, 'unreviewed' (every kind), or
 * undefined when no set lists it. Undefined is not a verdict that the operation is safe: the gate test
 * is what forces each gated operation to be listed.
 */
export function contentKindsOf(
  key: string,
  table: ContentOperationTable = CONTENT_OPERATION_TABLE,
): readonly ContentKind[] | 'unreviewed' | undefined {
  if (isListed(table.unreviewed, key)) return 'unreviewed';
  const kinds = KIND_ORDER.filter((kind) => isListed(table.kinds[kind], key));
  return kinds.length > 0 ? kinds : undefined;
}

/** The key of a v1 call: v1Call(object, action). */
export function v1OperationKey(object: string, action: string): string {
  return `v1:${object}:${action}`;
}

/**
 * The key of a v1 registry operation, such as "GET ?object=audio&action=play". Undefined when the
 * registry key carries no object and action.
 */
export function v1OperationKeyOf(registryKey: string): string | undefined {
  const match = /[?&]object=([^&]+)&action=([^&]+)/.exec(registryKey);
  return match ? v1OperationKey(match[1], match[2]) : undefined;
}

/** Whether an operation key falls under the review gate. */
export function isGatedOperation(key: string): boolean {
  const path = key.startsWith('v1:') ? (key.split(':')[1] ?? '') : key.slice(key.indexOf(' ') + 1);
  return CONTENT_GATE.test(path);
}

export interface ContentCoverage {
  /** Gated operations that no set lists. */
  readonly unreviewed: readonly string[];
  /** Gated operations that more than one set lists. */
  readonly conflicting: readonly string[];
  /** Listed operations that no current operation has. */
  readonly stale: readonly string[];
}

/** Compares the review sets with the operations the registries generate. Pure: callers supply the keys. */
export function contentCoverage(
  current: Iterable<string>,
  table: ContentOperationTable = CONTENT_OPERATION_TABLE,
): ContentCoverage {
  const present = new Set<string>(current);
  const unreviewed: string[] = [];
  const conflicting: string[] = [];
  for (const key of [...present].filter(isGatedOperation).sort()) {
    const memberships =
      (isListed(table.unreviewed, key) ? 1 : 0) +
      (KIND_ORDER.some((kind) => isListed(table.kinds[kind], key)) ? 1 : 0) +
      (isListed(table.free, key) ? 1 : 0);
    if (memberships === 0) unreviewed.push(key);
    if (memberships > 1) conflicting.push(key);
  }
  const listed = new Set<string>([
    ...Object.keys(table.unreviewed),
    ...Object.keys(table.free),
    ...KIND_ORDER.flatMap((kind) => Object.keys(table.kinds[kind])),
  ]);
  const stale = [...listed].filter((key) => !present.has(key)).sort();
  return { unreviewed, conflicting, stale };
}
