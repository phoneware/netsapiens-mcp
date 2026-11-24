/**
 * Content operations (spec 3.6): which NetSapiens operations return or transmit a content kind, which return
 * records whose content fields the projection strips, and which have been reviewed as carrying none.
 *
 * Keys are normalizeOperationKey(method, pathTemplate) for v2 and "v1:<object>:<action>" for v1Call.
 * An operation is a content operation of kind K when its primary purpose is to return or transmit K, or when one of
 * its responses or requests can carry K. A record list whose content fields are all classified is not one: its
 * fields are stripped by the output projection, and the list is listed in RECORD_LIST_OPERATIONS with the kinds it
 * carries, so the gate knows it was reviewed.
 *
 * Every operation the gates flag (see gates.ts) must sit in exactly one set: CONTENT_OPERATIONS (for any kind),
 * UNREVIEWED_CONTENT_OPERATIONS, RECORD_LIST_OPERATIONS or REVIEWED_CONTENT_FREE. The gate test fails on an operation
 * nobody has reviewed and on an entry naming an operation that no longer exists. Changing an entry changes the
 * @content groups; the group snapshot shows the effect.
 */
import type { ContentKind } from './types.js';

const BASE_GATE =
  'record|transcri|vcon|audio|voicemail|vmail|message|msg|sms|mms|fax|insight|intelligence|summary|sentiment|media|greeting|moh|meeting|conference|export|sipflow|cradle|trace';

/** Paths (v2) that need a review entry. */
export const CONTENT_GATE = new RegExp(`${BASE_GATE}|subscri|event|webhook|conversation|playback|upload|email`, 'i');

/** v1 objects that need a review entry: the base words, and the v1 objects that carry or transmit content. */
export const V1_CONTENT_GATE = new RegExp(`${BASE_GATE}|event|conversation|email|call|upload`, 'i');

/** Call recordings: the audio of a call or of one meeting instance, with a signed link that plays it. */
const RECORDING_OPERATIONS = [
  'GET /domains/{}/recordings/{}',
  'GET /domains/{}/users/{}/recordings/{}',
  'GET /recordings/play',
  // Playback token for the recording of one meeting instance, from either method.
  'GET /domains/{}/users/{}/meetings/{}/sfu',
  'POST /domains/{}/users/{}/meetings/{}/sfu',
  // v1 audio files are read as call recordings (spec 3.6). That is conservative for greetings.
  'v1:audio:play',
  'v1:audio:read',
  'v1:recording:read',
] as const;

/** vCon documents: one response carries the call's recording, transcript and summary. */
const VCON_OPERATIONS = ['GET /domains/{}/cdrs/{}/vcon', 'GET /domains/{}/users/{}/vcon/{}', 'GET /domains/{}/vcon/{}'] as const;

/** Transcriptions: the transcript, with the AI summary and topics that the same response carries. */
const TRANSCRIPTION_OPERATIONS = ['GET /domains/{}/transcriptions'] as const;

/**
 * CDR schedule exports at all three scopes: list, read (which hands out a fresh signed link) and download. The v1
 * schedule create and update send CDR rows to an address or server, so they transmit the same kinds.
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

/** Event subscriptions: each posts the events of its model to a URL, so they transmit the kinds those events carry. */
const SUBSCRIPTION_TRANSMIT_OPERATIONS = [
  'POST /subscriptions',
  'PUT /subscriptions/{}',
  'POST /domains/{}/subscriptions',
  'PUT /domains/{}/subscriptions/{}',
  'v1:event:create',
] as const;

/**
 * Voicemail messages: the folder list, the single read, the play, the delete, the save and the forward. The folder
 * list carries the message, its transcript and its fax pages; the change operations return the same records on the
 * hosts that answer with them (44.3 to 45.0).
 */
const VOICEMAIL_OPERATIONS = [
  'GET /domains/{}/users/{}/voicemails/{}',
  'GET /domains/{}/users/{}/voicemails/{}/{}',
  'GET /domains/{}/users/{}/voicemails/{}/{}/play',
  'DELETE /domains/{}/users/{}/voicemails/{}/{}',
  'PATCH /domains/{}/users/{}/voicemails/{}/{}/save',
  'PATCH /domains/{}/users/{}/voicemails/{}/{}/forward',
] as const;

/** Voicemail reads and changes that also return the transcript of the message. */
const VOICEMAIL_TRANSCRIPT_OPERATIONS = [
  'GET /domains/{}/users/{}/voicemails/{}',
  'GET /domains/{}/users/{}/voicemails/{}/{}',
  'DELETE /domains/{}/users/{}/voicemails/{}/{}',
  'PATCH /domains/{}/users/{}/voicemails/{}/{}/save',
  'PATCH /domains/{}/users/{}/voicemails/{}/{}/forward',
] as const;

/**
 * Writes that change where voicemail, its alerts or its reminders are delivered: forwarding, email copies of new
 * voicemail, and reminder destinations. Conservatively voicemail, because each can send content to a new place. A
 * user write is included for its email alert settings, which name a copy list.
 */
const VOICEMAIL_REDIRECT_OPERATIONS = [
  'POST /domains/{}/users',
  'PUT /domains/{}/users/{}',
  'POST /domains/{}/users/{}/vmailnag',
  'PUT /domains/{}/users/{}/vmailnag',
  'v1:subscriber:create',
  'v1:subscriber:update',
  'v1:audio:update',
  'v1:audio:link_update',
  'v1:audio:link_delete',
  'v1:vmailnag:create',
  'v1:vmailnag:update',
] as const;

/**
 * Message bodies and sends. Message-session rows are not here: they are record lists whose last message is stripped
 * by the Messagesession field class.
 */
const MESSAGE_BODY_OPERATIONS = [
  'GET /domains/{}/users/{}/messagesessions/{}/messages',
  'POST /domains/{}/users/{}/messagesessions/{}/messages',
  'POST /domains/{}/users/{}/messages',
  'POST /domains/{}/users/{}/messagesessions',
] as const;

/**
 * SIP traces: the call and SIP message traces, their lists, their exports and their reads. A SIP MESSAGE carries an
 * SMS body, so a trace read can carry SMS text (conservative). Injecting a trace, storing it and revoking a share do
 * not return trace content.
 */
const SIP_TRACE_OPERATIONS = [
  'GET /sipflow',
  'GET /sipflow/download/{k}.txt',
  'GET /sipflow/events',
  'GET /sipflow/export',
  'GET /sipflow/{}',
  'POST /sipflow/export',
  'GET /domains/{}/sipflow/export',
  'GET /domains/{}/sipflow/{}',
  'POST /domains/{}/sipflow/export',
  'GET /domains/{}/cdrs/{}/sipflow',
  'GET /domains/{}/cdrs/{}/cradle2grave',
  'v1:trace:export',
] as const;

/**
 * Fax pages: documents, thumbnails, sends and the rendered cover page that a send attaches. The list and read are
 * fax_page because their Fax records carry signed document links the field table does not classify.
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
function isListed(table: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.hasOwn(table, key);
}

/** Each operation a kind's set lists. A key may appear under several kinds. */
export const CONTENT_OPERATIONS: Readonly<Record<ContentKind, Readonly<Record<string, true>>>> = {
  call_recording: lookup([...RECORDING_OPERATIONS, ...VCON_OPERATIONS]),
  transcript: lookup([
    ...TRANSCRIPTION_OPERATIONS,
    ...VCON_OPERATIONS,
    ...CDR_EXPORT_OPERATIONS,
    ...SUBSCRIPTION_TRANSMIT_OPERATIONS,
    ...VOICEMAIL_TRANSCRIPT_OPERATIONS,
    'v1:cdrexport:create',
    'v1:cdrexport:download',
    'v1:cdrexport:read',
    'v1:cdrexport:update',
    'v1:audio:play',
    'v1:audio:read',
    'v1:conversation:read',
    'v1:recording:read',
  ]),
  voicemail: lookup([
    ...VOICEMAIL_OPERATIONS,
    ...VOICEMAIL_REDIRECT_OPERATIONS,
    ...SUBSCRIPTION_TRANSMIT_OPERATIONS,
    'v1:conversation:read',
  ]),
  sms_text: lookup([
    ...MESSAGE_BODY_OPERATIONS,
    ...SIP_TRACE_OPERATIONS,
    ...SUBSCRIPTION_TRANSMIT_OPERATIONS,
    'v1:conversation:read',
    'v1:email:create',
    'POST /domains/{}/users/{}/email',
    'POST /email',
    'v1:message:create',
    'v1:message:read',
    'v1:message:read_media',
    'v1:messagesession:read',
  ]),
  ai_summary: lookup([
    ...TRANSCRIPTION_OPERATIONS,
    ...VCON_OPERATIONS,
    ...CDR_EXPORT_OPERATIONS,
    ...SUBSCRIPTION_TRANSMIT_OPERATIONS,
    'v1:cdrexport:create',
    'v1:cdrexport:download',
    'v1:cdrexport:read',
    'v1:cdrexport:update',
    'v1:conversation:read',
    'v1:recording:read',
  ]),
  fax_page: lookup([
    ...FAX_OPERATIONS,
    // Plays a voicemail-folder item, which may be a fax image; the folder list may hold faxes too.
    'GET /domains/{}/users/{}/voicemails/{}',
    'GET /domains/{}/users/{}/voicemails/{}/{}/play',
    'v1:audio:play',
    'v1:audio:read',
    'v1:conversation:read',
  ]),
};

/**
 * iNSight reads. Not reviewed (spec 3.6), so they count as every kind and any denied kind refuses them.
 */
export const UNREVIEWED_CONTENT_OPERATIONS: Readonly<Record<string, true>> = lookup([
  'GET /insight/active_alerts',
  'GET /insight/{}',
  // v1 call report: its fields are not in the apidoc, so it is unreviewed and counts as every kind until it is read.
  'v1:call:report',
]);

/** A record list that carries content kinds in its fields. The projection strips those fields; the operation is not refused. */
export interface RecordListEntry {
  /** The kinds the list's fields carry, which the projection strips when a kind is set to strip or deny. */
  readonly kinds: readonly ContentKind[];
  readonly reason: string;
}

function recordLists(kinds: readonly ContentKind[], reason: string, keys: readonly string[]): Array<readonly [string, RecordListEntry]> {
  return keys.map((key) => [key, { kinds, reason }] as const);
}

/**
 * Record lists and reads whose fields carry classified content. Listing them keeps the gate honest without refusing
 * the call: their content fields are stripped, and the rest of the record stays usable.
 */
export const RECORD_LIST_OPERATIONS: Readonly<Record<string, RecordListEntry>> = Object.freeze(
  Object.fromEntries([
    ...recordLists(
      ['ai_summary'],
      'CDR records carry call intelligence: summary, topics, sentiment and its percentages, which are stripped by field',
      [
        'GET /cdrs/{}',
        'GET /domains/{}/cdrs',
        'GET /domains/{}/cdrs/{}',
        'GET /domains/{}/users/{}/cdrs',
        'GET /domains/{}/users/{}/cdrs/{}',
      ],
    ),
    ...recordLists(
      ['sms_text'],
      'message-session records carry the last message, which is stripped by field',
      [
        'GET /domains/{}/messagesessions',
        'GET /domains/{}/users/{}/messagesessions',
        'GET /domains/{}/users/{}/messagesessions/{}',
      ],
    ),
  ]),
);

/**
 * Gated operations reviewed as carrying no content kind. Each entry names the reason it is free. Records that embed
 * classified content fields are in RECORD_LIST_OPERATIONS instead.
 */
export const REVIEWED_CONTENT_FREE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries([
    ...recordLists(
      [],
      'SIP trace revocation, storage and injection: no trace content is returned',
      [
        'DELETE /domains/{}/sipflow/share/{}',
        'DELETE /sipflow/share/{}',
        'POST /domains/{}/cdrs/{}/sipflow/store',
        'POST /domains/{}/sipflow/{}/store',
        'POST /sipflow/event',
        'POST /sipflow/{}/store',
      ],
    ),
    ...recordLists(
      [],
      'conference, meeting and video schedules, participants, events and join tokens: no recording or message content',
      [
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
        'POST /domains/{}/users/{}/video/conference',
        'POST /meetings/register/{}',
        'PUT /domains/{}/conferences/{}',
        'PUT /domains/{}/conferences/{}/participants/{}',
        'PUT /domains/{}/users/{}/meetings/{}',
        'PUT /domains/{}/users/{}/meetings/{}/attendee/{}',
      ],
    ),
    ...recordLists(
      [],
      'recording configuration, servers, storage and recording entries: settings that say which addresses are recorded',
      [
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
      ],
    ),
    ...recordLists(
      [],
      'fax setup: numbers, vendors, cover-page templates and deletes; fax documents are fax_page above',
      [
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
      ],
    ),
    ...recordLists(
      [],
      'SMS setup: numbers, carriers, blocks and deletes, plus message-session counts and changes that return no message',
      [
        'DELETE /domains/{}/inboxes/{}/smsnumbers/{}',
        'DELETE /domains/{}/smsblocks/{}',
        'DELETE /domains/{}/smsnumbers/{}',
        'DELETE /domains/{}/users/{}/messagesessions/{}',
        'DELETE /smscarriers/{}',
        'GET /domains/{}/smsblocks',
        'GET /domains/{}/smsblocks/{}',
        'GET /domains/{}/smsnumbers',
        'GET /domains/{}/smsnumbers/count',
        'GET /domains/{}/smsnumbers/{}',
        'GET /domains/{}/users/{}/messagesessions/count',
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
      ],
    ),
    ...recordLists(
      [],
      'greetings, music on hold and hold messages: audio an administrator uploads, not one of the six kinds',
      [
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
      ],
    ),
    ...recordLists(
      [],
      'voicemail reminder reads and deletes, and voicemail counts: no message content and no destination set',
      [
        'DELETE /domains/{}/users/{}/vmailnag',
        'GET /domains/{}/users/{}/vmailnag',
        'GET /domains/{}/users/{}/vmailnag/count',
        'GET /domains/{}/users/{}/voicemails/{}/count',
      ],
    ),
    ...recordLists(
      [],
      'v1 audio counts, deletes and uploads: no audio is returned, and a delete removes a file without reading it',
      ['v1:audio:count', 'v1:audio:delete', 'v1:audio:upload'],
    ),
    ...recordLists(
      [],
      'v1 CDR export schedule deletes: the schedule is removed and no CDR row is returned',
      ['v1:cdrexport:delete'],
    ),
    ...recordLists(
      [],
      'v1 conferences and meetings: schedules, participants and events, with no recording or message content',
      [
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
      ],
    ),
    ...recordLists(
      [],
      'v1 message deletion and message-session changes: no message text is returned, and a session read is sms_text above',
      [
        'v1:message:delete',
        'v1:messagesession:accept',
        'v1:messagesession:delete',
        'v1:messagesession:dispatch',
        'v1:messagesession:leave',
        'v1:messagesession:update',
      ],
    ),
    ...recordLists(
      [],
      'v1 recording settings: enabling, disabling and updating recording records; reads are call_recording above',
      ['v1:recording:create', 'v1:recording:delete', 'v1:recording:update'],
    ),
    ...recordLists([], 'v1 SMS numbers: setup, with no message content', [
      'v1:smsnumber:count',
      'v1:smsnumber:create',
      'v1:smsnumber:read',
      'v1:smsnumber:update',
    ]),
    ...recordLists(
      [],
      'subscription settings: which events go to which URL. Reads and deletes return settings, not events',
      [
        'DELETE /domains/{}/subscriptions/{}',
        'DELETE /subscriptions/{}',
        'GET /domains/{}/subscriptions',
        'GET /subscriptions',
        'v1:event:delete',
        'v1:event:read',
      ],
    ),
    ...recordLists(
      [],
      'video conference event subscriptions: meeting events, with no call, message or voicemail content',
      [
        'DELETE /domains/{}/video/subscription/{}',
        'GET /domains/{}/video/subscription/{}',
        'POST /domains/{}/video/subscription/{}',
        'PUT /domains/{}/video/subscriptions',
      ],
    ),
    ...recordLists(
      [],
      'v1 voicemail reminders: reads, counts and deletes; a reminder create or update is voicemail above',
      ['v1:vmailnag:count', 'v1:vmailnag:delete', 'v1:vmailnag:read'],
    ),
    ...recordLists(
      [],
      'e-mail report schedules and statistics e-mails: which statistics go to which address, not call content',
      ['DELETE /domains/{}/users/{}/emailreports', 'GET /domains/{}/users/{}/emailreports', 'PUT /domains/{}/users/{}/emailreports'],
    ),
    ...recordLists(
      [],
      'call-center statistics sent by e-mail: counts and durations, not one of the six kinds',
      ['POST /domains/{}/callcenter-reports/{}/send-email'],
    ),
    ...recordLists(
      [],
      'subscription settings: the list of subscriptions and a single subscription read',
      ['GET /domains/{}/subscriptions/list', 'GET /subscriptions/{}'],
    ),
    ...recordLists(
      [],
      'e-mail address checks: whether an address is verified or valid; no message content',
      ['GET /domains/{}/users/{}/email/checkVerified/{}', 'POST /email/validate'],
    ),
    ...recordLists(
      [],
      'speech-word vocabulary uploads: recognition hints an administrator supplies, not call content',
      ['POST /domains/{}/speech-words/{}/upload', 'POST /speech-words/{}/upload'],
    ),
    ...recordLists(
      [],
      'v1 call control: answer, hold, park, transfer, disconnect, record, play and place calls; no call content is returned',
      [
        'v1:call:answer',
        'v1:call:call',
        'v1:call:call_to_playback',
        'v1:call:call_to_record',
        'v1:call:disconnect',
        'v1:call:hold_orig',
        'v1:call:hold_term',
        'v1:call:park',
        'v1:call:record_off',
        'v1:call:record_on',
        'v1:call:record_pause',
        'v1:call:record_unpause',
        'v1:call:reject',
        'v1:call:unhold',
        'v1:call:xfer',
        'v1:call:xfer_peer',
      ],
    ),
    ...recordLists(
      [],
      'live call state and counts: the active call carries addresses and states, with no content',
      ['v1:call:count', 'v1:call:read', 'v1:callidemgr:read'],
    ),
    ...recordLists(
      [],
      'call queue settings: queue configuration, with no call content',
      ['v1:callqueue:create', 'v1:callqueue:delete', 'v1:callqueue:read', 'v1:callqueue:update'],
    ),
    ...recordLists(
      [],
      'queue e-mail report schedules: which statistics go to which address, not call content',
      ['v1:callqueueemailreport:create', 'v1:callqueueemailreport:delete', 'v1:callqueueemailreport:read', 'v1:callqueueemailreport:update'],
    ),
    ...recordLists([], 'queue statistics: counts and averages, not call content', ['v1:callqueuereport:read', 'v1:callqueuestat:read']),
    ...recordLists(
      [],
      'wake-up call requests and queued calls: scheduling, with no call content',
      ['v1:callrequest:addWakeUp', 'v1:callrequest:delWakeUp', 'v1:callrequest:read', 'v1:queuedcall:create'],
    ),
    ...recordLists([], 'v1 file uploads: the server stores the file and returns no content', ['v1:upload:create', 'v1:upload:upload']),
  ].map(([key, entry]) => [key, entry.reason] as const)),
);

/** The sets together, so the gate test and the lookups read one value. */
export interface ContentOperationTable {
  readonly kinds: Readonly<Record<ContentKind, Readonly<Record<string, true>>>>;
  readonly unreviewed: Readonly<Record<string, true>>;
  readonly records: Readonly<Record<string, RecordListEntry>>;
  readonly free: Readonly<Record<string, string>>;
}

export const CONTENT_OPERATION_TABLE: ContentOperationTable = {
  kinds: CONTENT_OPERATIONS,
  unreviewed: UNREVIEWED_CONTENT_OPERATIONS,
  records: RECORD_LIST_OPERATIONS,
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
 * What an operation is classified as for refusal: the kinds it returns or transmits, 'unreviewed' (every kind), or
 * undefined when no refusal set lists it. Record lists are not refused, so they are undefined here; see listedKindsOf.
 */
export function contentKindsOf(
  key: string,
  table: ContentOperationTable = CONTENT_OPERATION_TABLE,
): readonly ContentKind[] | 'unreviewed' | undefined {
  if (isListed(table.unreviewed, key)) return 'unreviewed';
  const kinds = KIND_ORDER.filter((kind) => isListed(table.kinds[kind], key));
  return kinds.length > 0 ? kinds : undefined;
}

/**
 * The kinds the gate requires an operation to be listed under: every kind a set lists it with, every kind a record
 * list carries, all kinds when it is unreviewed, none when it is reviewed as free, and undefined when no set lists it.
 */
export function listedKindsOf(
  key: string,
  table: ContentOperationTable = CONTENT_OPERATION_TABLE,
): readonly ContentKind[] | 'unreviewed' | undefined {
  if (isListed(table.unreviewed, key)) return 'unreviewed';
  const kinds = KIND_ORDER.filter((kind) => isListed(table.kinds[kind], key));
  if (kinds.length > 0) return kinds;
  if (isListed(table.records, key)) return table.records[key].kinds;
  if (isListed(table.free, key)) return [];
  return undefined;
}

/** The key of a v1 call: v1Call(object, action). */
export function v1OperationKey(object: string, action: string): string {
  return `v1:${object}:${action}`;
}

/**
 * The key of a v1 registry operation, such as "GET ?object=audio&action=play". Undefined when the registry key carries
 * no object and action.
 */
export function v1OperationKeyOf(registryKey: string): string | undefined {
  const match = /[?&]object=([^&]+)&action=([^&]+)/.exec(registryKey);
  return match ? v1OperationKey(match[1], match[2]) : undefined;
}

/** Whether an operation key falls under the review gate. */
export function isGatedOperation(key: string): boolean {
  if (key.startsWith('v1:')) return V1_CONTENT_GATE.test(key.split(':')[1] ?? '');
  return CONTENT_GATE.test(key.slice(key.indexOf(' ') + 1));
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
      (isListed(table.records, key) ? 1 : 0) +
      (isListed(table.free, key) ? 1 : 0);
    if (memberships === 0) unreviewed.push(key);
    if (memberships > 1) conflicting.push(key);
  }
  const listed = new Set<string>([
    ...Object.keys(table.unreviewed),
    ...Object.keys(table.records),
    ...Object.keys(table.free),
    ...KIND_ORDER.flatMap((kind) => Object.keys(table.kinds[kind])),
  ]);
  const stale = [...listed].filter((key) => !present.has(key)).sort();
  return { unreviewed, conflicting, stale };
}
