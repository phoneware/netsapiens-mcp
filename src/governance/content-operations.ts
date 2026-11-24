/**
 * Content operations (spec 3.6): which NetSapiens operations return or transmit a content kind, which return records
 * whose content fields the projection strips, and which have been reviewed as carrying none.
 *
 * Keys are normalizeOperationKey(method, pathTemplate) for v2 and "v1:<object>:<action>" for v1Call. An operation is a
 * content operation of kind K when its primary purpose is to return or transmit K, or when one of its responses or
 * requests can carry K. A write that sets where content goes (an address, a host, a server, a bucket, a number's
 * destination) is a content operation of the kind that the destination receives. A record list whose content fields are
 * all classified is not one: its fields are stripped by the output projection, so it is in RECORD_LIST_OPERATIONS.
 *
 * Every operation the gates flag (gates.ts) must sit in exactly one set: CONTENT_OPERATIONS (for any kind),
 * UNREVIEWED_CONTENT_OPERATIONS, RECORD_LIST_OPERATIONS or REVIEWED_CONTENT_FREE. Response names the gate matches must
 * be explained by a classified field, the setting whitelist, or NAME_REVIEWS. The coverage test fails on an unreviewed
 * gated operation and on an entry naming an operation that no longer exists. Changing an entry changes the @content
 * groups; the group snapshot shows the effect.
 *
 * Two limits are documented here. Live-audio routing (a call's transfer and answer destinations, forwarding answer rules,
 * calls placed to a first party, participants dialled into a live conference, v1 call operations, queued and wake-up calls,
 * SIP connections and routes) sends live audio, which is not one of the six kinds, so those operations stay free with a
 * reason that names the destination. Capture enablement (queue, device, connection, meeting and call recording switches,
 * and v1 call:record_on) returns and transmits no content, so it is not a content operation. Both limits are protected only
 * by access read, so a profile that denies content must also be read-only.
 */
import type { ContentKind } from './types.js';

const BASE_GATE =
  'record|transcri|vcon|audio|voicemail|vmail|message|msg|sms|mms|fax|insight|intelligence|summary|sentiment|media|greeting|moh|meeting|conference|export|sipflow|cradle|trace';

/** Paths (v2) that need a review entry. */
export const CONTENT_GATE = new RegExp(`${BASE_GATE}|subscri|event|webhook|conversation|playback|upload|email`, 'i');

/** v1 objects that need a review entry: the base words, and the v1 objects that carry, transmit or set destinations. */
export const V1_CONTENT_GATE = new RegExp(`${BASE_GATE}|event|conversation|email|call|upload|schedule|cdr|domain`, 'i');

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
  // Mixes voicemail, call and chat records, so it can carry a recording link.
  'v1:conversation:read',
  'v1:recording:read',
] as const;

/** vCon documents: one response carries the call's recording, transcript and summary. */
const VCON_OPERATIONS = ['GET /domains/{}/cdrs/{}/vcon', 'GET /domains/{}/users/{}/vcon/{}', 'GET /domains/{}/vcon/{}'] as const;

/** Transcriptions: the transcript, with the AI summary and topics that the same response carries. */
const TRANSCRIPTION_OPERATIONS = ['GET /domains/{}/transcriptions'] as const;

/**
 * CDR schedule exports at all three scopes: list, read (which hands out a fresh signed link) and download. The writes that
 * set where these exports go are CDR_SCHEDULE_WRITE_OPERATIONS.
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
 * CDR schedule writes: each sets where scheduled CDR exports are sent, to an e-mail address or to an SCP, FTP or SFTP
 * server. The export carries the call records and their call intelligence, so the write transmits what the export returns.
 */
const CDR_SCHEDULE_WRITE_OPERATIONS = [
  'POST /domains/{}/schedule',
  'PUT /domains/{}/schedule/{}',
  'POST /resellers/{}/schedule',
  'PUT /resellers/{}/schedule/{}',
  'POST /schedule',
  'PUT /schedule/{}',
  'v1:cdrschedule:create',
  'v1:cdrschedule:update',
] as const;

/**
 * Writes that set where call recordings or call media are kept or sent: the storage a domain archives to, the recording
 * servers that receive call media (a core server's recording-server map included), the entries that choose which addresses
 * are recorded, the entry sync that copies them to a server, the archive configurations, and the free-form recording
 * configuration published to every server (unverified). Reads of these settings stay in REVIEWED_CONTENT_FREE.
 */
const RECORDING_DESTINATION_OPERATIONS = [
  'POST /domains/{}/recording-storage',
  'PUT /domains/{}/recording-storage/{}',
  'POST /recordings/servers',
  'PUT /recordings/servers/{}',
  'POST /recordings/entries',
  'PUT /recordings/entries',
  'POST /recordings/servers/{}/entries',
  'PUT /recordings/servers/{}/entries',
  'POST /recordings/archive-configs',
  'PUT /recordings/archive-configs/{}/{}/{}',
  'v1:recording:create',
  'v1:recording:update',
  'PUT /recordings/coreservers/{}',
  'POST /recordings/servers/{}/entries/sync',
  'POST /recordings/config',
  'PUT /recordings/config/{}',
  'POST /recordings/nmc-config',
  'PUT /recordings/nmc-config/{}',
] as const;

/**
 * Writes to a user's video host profile. The profile sets the e-mail address that receives the host's meeting records and
 * whether the host records meetings, so the write is conservatively call_recording.
 */
const VIDEO_HOST_RECORDING_OPERATIONS = ['POST /domains/{}/users/{}/host', 'PUT /domains/{}/users/{}/host'] as const;

/** Event subscriptions: each posts the events of its model to a URL, so they transmit the kinds those events carry. */
const SUBSCRIPTION_TRANSMIT_OPERATIONS = [
  'POST /subscriptions',
  'PUT /subscriptions/{}',
  'POST /domains/{}/subscriptions',
  'PUT /domains/{}/subscriptions/{}',
  'v1:event:create',
] as const;

/**
 * Push registrations: each sets the device or web-push endpoint that receives call and message notifications. The
 * notification payload is not verified, so each registration is conservatively sms_text and voicemail. Deletes are listed
 * with the writes, since they change the same registrations.
 */
const PUSH_REGISTRATION_OPERATIONS = [
  'POST /push',
  'PUT /push',
  'DELETE /push',
  'POST /domains/{}/push',
  'PUT /domains/{}/push',
  'DELETE /domains/{}/push',
  'POST /domains/{}/users/{}/push',
  'PUT /domains/{}/users/{}/push',
  'DELETE /domains/{}/users/{}/push',
] as const;

/**
 * Voicemail messages: the folder list, the single read, the play, the delete, the save and the forward. The folder list
 * carries the message, its transcript and its fax pages; the change operations return the same records on the hosts that
 * answer with them (44.3 to 45.0).
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
 * voicemail, and reminder destinations. Conservatively voicemail, because each can send content to a new place.
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
 * Writes that send domain e-mail through an SMTP relay. Voicemail, transcripts and fax pages are mailed through the relay
 * the domain or reseller names, so changing the relay changes where they go. A v1 domain create carries the same fields.
 */
const SMTP_RELAY_OPERATIONS = [
  'POST /domains',
  'PUT /domains/{}',
  'PUT /resellers/{}',
  'POST /resellers',
  'v1:domain:create',
  'v1:domain:update',
] as const;

/**
 * Writes that set a user's e-mail address, where fax PDFs and voicemail transcripts are mailed. The voicemail alerts that
 * name the same address are in VOICEMAIL_REDIRECT_OPERATIONS.
 */
const USER_ADDRESS_OPERATIONS = [
  'POST /domains/{}/users',
  'PUT /domains/{}/users/{}',
  'v1:subscriber:create',
  'v1:subscriber:update',
] as const;

/** Writes that set where a fax number's inbound e-mail goes, including the fax PDF it attaches. */
const FAX_NUMBER_WRITE_OPERATIONS = [
  'POST /domains/{}/faxnumbers',
  'PUT /domains/{}/faxnumbers/{}',
  'PUT /domains/{}/users/{}/faxnumbers/{}',
] as const;

/**
 * Writes that redirect SMS: a session's members, a number's destination, a number assigned to an inbox, an inbox member,
 * a phone number's SMS destination, a carrier's outbound URL (which receives every outbound message), a v1 SMS number's
 * destination, and a queue agent (which receives the SMS conversations its queue routes to it). Whoever is added or named
 * receives the text.
 */
const SMS_REDIRECT_OPERATIONS = [
  'PUT /domains/{}/users/{}/messagesessions/{}',
  'PUT /domains/{}/users/{}/messagesessions/{}/accept',
  'POST /domains/{}/smsnumbers',
  'PUT /domains/{}/smsnumbers/{}',
  'POST /domains/{}/phonenumbers',
  'PUT /domains/{}/phonenumbers',
  'PUT /domains/{}/phonenumbers/{}',
  'POST /domains/{}/inboxes/{}/smsnumbers',
  'POST /domains/{}/inboxes/{}/members',
  'v1:messagesession:accept',
  'v1:messagesession:update',
  'POST /smscarriers',
  'PUT /smscarriers/{}',
  'v1:smsnumber:create',
  'v1:smsnumber:update',
  'POST /domains/{}/callqueues/{}/agents',
  'PUT /domains/{}/callqueues/{}/agents/{}',
  'v1:agent:create',
  'v1:agent:update',
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
 * SIP traces: the call and SIP message traces, their lists, their exports and their reads. A SIP MESSAGE carries an SMS
 * body, so a trace read can carry SMS text (conservative). A store returns a key that opens the stored trace with no token
 * for up to 30 days, so it is sms_text too (conservative: the whole trace, SIP messages included). Injecting a trace and
 * revoking a share do not return trace content.
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
  'POST /domains/{}/cdrs/{}/sipflow/store',
  'POST /domains/{}/sipflow/{}/store',
  'POST /sipflow/{}/store',
] as const;

/**
 * Fax pages: documents, thumbnails, sends and the rendered cover page that a send attaches. The list and read are fax_page
 * because their Fax records carry signed document links the field table does not classify.
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
  call_recording: lookup([...RECORDING_OPERATIONS, ...RECORDING_DESTINATION_OPERATIONS, ...VIDEO_HOST_RECORDING_OPERATIONS, ...VCON_OPERATIONS]),
  transcript: lookup([
    ...SMTP_RELAY_OPERATIONS,
    ...USER_ADDRESS_OPERATIONS,
    ...TRANSCRIPTION_OPERATIONS,
    ...VCON_OPERATIONS,
    ...CDR_EXPORT_OPERATIONS,
    ...CDR_SCHEDULE_WRITE_OPERATIONS,
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
    // v1 CDR records and reports carry the call intelligence that the v2 CDR lists do, with no output resource to strip it.
    'v1:cdr2:read',
    'v1:cdr2:report',
  ]),
  voicemail: lookup([
    ...VOICEMAIL_OPERATIONS,
    ...PUSH_REGISTRATION_OPERATIONS,
    ...VOICEMAIL_REDIRECT_OPERATIONS,
    ...SMTP_RELAY_OPERATIONS,
    ...SUBSCRIPTION_TRANSMIT_OPERATIONS,
    'v1:audio:play',
    'v1:audio:read',
    'v1:conversation:read',
  ]),
  sms_text: lookup([
    ...SMS_REDIRECT_OPERATIONS,
    ...PUSH_REGISTRATION_OPERATIONS,
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
    ...CDR_SCHEDULE_WRITE_OPERATIONS,
    ...SUBSCRIPTION_TRANSMIT_OPERATIONS,
    'v1:cdrexport:create',
    'v1:cdrexport:download',
    'v1:cdrexport:read',
    'v1:cdrexport:update',
    'v1:conversation:read',
    'v1:recording:read',
    'v1:cdr2:read',
    'v1:cdr2:report',
  ]),
  fax_page: lookup([
    ...SMTP_RELAY_OPERATIONS,
    ...USER_ADDRESS_OPERATIONS,
    ...FAX_NUMBER_WRITE_OPERATIONS,
    ...FAX_OPERATIONS,
    // The folder list may hold faxes, and the play of a voicemail-folder item may be a fax image.
    'GET /domains/{}/users/{}/voicemails/{}',
    'GET /domains/{}/users/{}/voicemails/{}/{}/play',
    'v1:audio:play',
    'v1:audio:read',
    'v1:conversation:read',
  ]),
};

/**
 * iNSight reads. Not reviewed (spec 3.6), so they count as every kind and any denied kind refuses them. The v1 call report's
 * fields are not in the apidoc, so it is unreviewed too.
 */
export const UNREVIEWED_CONTENT_OPERATIONS: Readonly<Record<string, true>> = lookup([
  'GET /insight/active_alerts',
  'GET /insight/{}',
  'v1:call:report',
]);

/** A record list that carries content kinds in its fields. The projection strips those fields; the operation is not refused. */
export interface RecordListEntry {
  /** The kinds the list's fields carry, which the projection strips when a kind is set to strip or deny. */
  readonly kinds: readonly ContentKind[];
  readonly reason: string;
}

/** Record-list entries for a group of keys that share their kinds and their reason. */
function recordsOf(kinds: readonly ContentKind[], reason: string, keys: readonly string[]): Array<readonly [string, RecordListEntry]> {
  return keys.map((key) => [key, { kinds, reason }] as const);
}

/** Reviewed-free entries for a group of keys that share their reason. */
function freeOf(reason: string, keys: readonly string[]): Array<readonly [string, string]> {
  return keys.map((key) => [key, reason] as const);
}

/**
 * Record lists and reads whose fields carry classified content. Listing them keeps the gate honest without refusing the
 * call: their content fields are stripped, and the rest of the record stays usable. Each entry's kinds are the kinds its
 * output resource classifies, which a test checks.
 */
export const RECORD_LIST_OPERATIONS: Readonly<Record<string, RecordListEntry>> = Object.freeze(
  Object.fromEntries([
    ...recordsOf(['ai_summary'], 'CDR records carry call intelligence (summary, topics, sentiment and their percentages), stripped by field', [
      'GET /cdrs',
      'GET /cdrs/{}',
      'GET /domains/{}/cdrs',
      'GET /domains/{}/cdrs/{}',
      'GET /domains/{}/users/{}/cdrs',
      'GET /domains/{}/users/{}/cdrs/{}',
    ]),
    ...recordsOf(['sms_text'], 'message-session records carry the last message, which is stripped by field', [
      'GET /domains/{}/messagesessions',
      'GET /domains/{}/users/{}/messagesessions',
      'GET /domains/{}/users/{}/messagesessions/{}',
    ]),
    // Audio file records share one type with voicemail. The shared type classes the file link as voicemail, and on the
    // older hosts the transcription as transcript, so those fields are stripped by field. The audio is not caller content.
    ...recordsOf(
      ['transcript', 'voicemail'],
      'audio file records an administrator or owner uploads (music on hold, prompts, greetings): their link and transcription are classed by the audio-file type they share with voicemail, and stripped by field',
      [
        'GET /domains/{}/moh',
        'GET /domains/{}/msg',
        'GET /domains/{}/users/{}/greetings',
        'GET /domains/{}/users/{}/greetings/{}',
        'GET /domains/{}/users/{}/moh',
        'GET /domains/{}/users/{}/msg',
        'POST /domains/{}/moh',
        'POST /domains/{}/users/{}/moh',
        'PUT /domains/{}/moh/{}',
        'PUT /domains/{}/users/{}/moh/{}',
      ],
    ),
    ...recordsOf(
      ['voicemail'],
      'audio file records an administrator or owner uploads (music on hold, prompts, greetings, auto-attendant greetings): the script text they carry is classed voicemail and stripped by field; the audio is not caller content',
      [
        'DELETE /domains/{}/users/{}/autoattendants/{}',
        'GET /domains/{}/autoattendants',
        'GET /domains/{}/moh/{}',
        'GET /domains/{}/msg/{}',
        'GET /domains/{}/users/{}/autoattendants/{}',
        'GET /domains/{}/users/{}/moh/{}',
        'GET /domains/{}/users/{}/msg/{}',
        'POST /domains/{}/autoattendants',
        'POST /domains/{}/msg',
        'POST /domains/{}/users/{}/greetings',
        'POST /domains/{}/users/{}/msg',
        'PUT /domains/{}/msg/{}',
        'PUT /domains/{}/users/{}/autoattendants/{}',
        'PUT /domains/{}/users/{}/greetings/{}',
        'PUT /domains/{}/users/{}/msg/{}',
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
    ...freeOf('SIP trace revocation and injection: no trace content is returned; a store is sms_text above, and an injected event receives a host name, not content', [
      'DELETE /domains/{}/sipflow/share/{}',
      'DELETE /sipflow/share/{}',
      'POST /sipflow/event',
    ]),
    ...freeOf('conference, meeting and video schedules: a schedule and its e-mail and dial-in settings, which receive no recording or message content; live audio into a meeting is a documented limit', [
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
      'POST /domains/{}/users/{}/meetings',
      'POST /domains/{}/users/{}/meetings/getId',
      'POST /domains/{}/users/{}/meetings/{}',
      'POST /domains/{}/users/{}/meetings/{}/instance/{}/log',
      'POST /meetings/register/{}',
      'PUT /domains/{}/conferences/{}',
      'PUT /domains/{}/users/{}/meetings/{}',
      'PUT /domains/{}/users/{}/meetings/{}/attendee/{}',
    ]),
    ...freeOf('recording configuration and inventory: reads and deletes, which set no recording destination; the writes that set one are call_recording above', [
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
    ]),
    ...freeOf('fax setup: numbers, vendors, cover-page templates and deletes; fax documents are fax_page above', [
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
      'POST /domains/{}/users/{}/fax/cover-page',
      'POST /fax/cover-page',
      'POST /resellers/{}/fax/cover-page',
      'PUT /domains/{}/fax/cover-page',
      'PUT /domains/{}/users/{}/fax/cover-page',
      'PUT /fax/cover-page',
      'PUT /resellers/{}/fax/cover-page',
    ]),
    ...freeOf('SMS setup: numbers, carriers, blocks and deletes, plus message-session counts and leaves; the redirects are sms_text above', [
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
      'POST /domains/{}/smsblocks',
      'POST /domains/{}/users/{}/smsblocks',
      'PUT /domains/{}/smsblocks/{}',
      'PUT /domains/{}/users/{}/messagesessions/{}/leave',
    ]),
    ...freeOf('greeting, music and message deletes, counts, reorders and players: no message content is returned', [
      'DELETE /domains/{}/moh/{}',
      'DELETE /domains/{}/msg/{}',
      'DELETE /domains/{}/users/{}/greetings/{}',
      'DELETE /domains/{}/users/{}/moh/{}',
      'DELETE /domains/{}/users/{}/msg/{}',
      'GET /domains/{}/moh/count',
      'GET /domains/{}/moh/{}/play',
      'GET /domains/{}/msg/count',
      'GET /domains/{}/msg/{}/play',
      'GET /domains/{}/users/{}/greetings/count',
      'GET /domains/{}/users/{}/greetings/{}/play',
      'GET /domains/{}/users/{}/moh/count',
      'GET /domains/{}/users/{}/moh/{}/play',
      'GET /domains/{}/users/{}/msg/count',
      'GET /domains/{}/users/{}/msg/{}/play',
      'PUT /domains/{}/moh/reorder',
      'PUT /domains/{}/msg/reorder',
      'PUT /domains/{}/users/{}/moh/reorder',
      'PUT /domains/{}/users/{}/msg/reorder',
    ]),
    ...freeOf('voicemail reminder reads and deletes, and voicemail counts: no message content and no destination set', [
      'DELETE /domains/{}/users/{}/vmailnag',
      'GET /domains/{}/users/{}/vmailnag',
      'GET /domains/{}/users/{}/vmailnag/count',
      'GET /domains/{}/users/{}/voicemails/{}/count',
    ]),
    ...freeOf('v1 audio counts, deletes and uploads: no audio is returned, and a delete removes a file without reading it', [
      'v1:audio:count',
      'v1:audio:delete',
      'v1:audio:upload',
    ]),
    ...freeOf('v1 CDR export schedule deletes: the schedule is removed and no CDR row is returned', ['v1:cdrexport:delete']),
    ...freeOf('v1 CDR schedule reads, counts and deletes: settings of an export, and no export is written', [
      'v1:cdrschedule:count',
      'v1:cdrschedule:delete',
      'v1:cdrschedule:read',
    ]),
    ...freeOf('v1 CDR table maintenance and record updates: the table is purged or tuned, and no record content is returned', [
      'v1:cdr2:count',
      'v1:cdr2:optimize',
      'v1:cdr2:purge',
      'v1:cdr2:update',
    ]),
    ...freeOf('v1 domain reads, counts, deletes and element lookups: settings and identifiers, and no destination is written', [
      'v1:domain:count',
      'v1:domain:delete',
      'v1:domain:read',
      'v1:elementdomain:read',
    ]),
    ...freeOf('v1 conferences and meetings: a schedule that receives its participant list and events, with no recording or message content', [
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
    ]),
    ...freeOf('v1 message deletes, session deletes, dispatches and leaves: no message text is returned; a leave removes a participant, who receives no text; session accepts and updates are sms_text above', [
      'v1:message:delete',
      'v1:messagesession:delete',
      'v1:messagesession:dispatch',
      'v1:messagesession:leave',
    ]),
    ...freeOf('v1 recording delete: removes a recording record and returns no content; reads are call_recording above', [
      'v1:recording:delete',
    ]),
    ...freeOf('v1 SMS numbers: counts and reads, with no message content; a create or update sets a destination and is sms_text above', [
      'v1:smsnumber:count',
      'v1:smsnumber:read',
    ]),
    ...freeOf('subscription settings: which events go to which URL. Reads and deletes return settings, not events', [
      'DELETE /domains/{}/subscriptions/{}',
      'DELETE /subscriptions/{}',
      'GET /domains/{}/subscriptions',
      'GET /subscriptions',
      'v1:event:delete',
      'v1:event:read',
    ]),
    ...freeOf('video conference event subscriptions: meeting events a host receives, with no call, message or voicemail content; the host limit is a count', [
      'DELETE /domains/{}/video/subscription/{}',
      'GET /domains/{}/video/subscription/{}',
      'POST /domains/{}/video/subscription/{}',
      'PUT /domains/{}/video/subscriptions',
    ]),
    ...freeOf('v1 voicemail reminders: reads, counts and deletes; a reminder create or update is voicemail above', [
      'v1:vmailnag:count',
      'v1:vmailnag:delete',
      'v1:vmailnag:read',
    ]),
    ...freeOf('e-mail report schedules and statistics e-mails: the statistics e-mailed to the addresses named, which the recipients receive as counts, not one of the six kinds', [
      'DELETE /domains/{}/users/{}/emailreports',
      'GET /domains/{}/users/{}/emailreports',
      'PUT /domains/{}/users/{}/emailreports',
    ]),
    ...freeOf('call-center statistics sent by e-mail: the recipients named receive counts and durations, not one of the six kinds', [
      'POST /domains/{}/callcenter-reports/{}/send-email',
      'POST /domains/{}/callcenter-reports',
      'PUT /domains/{}/callcenter-reports/{}',
    ]),
    ...freeOf('subscription settings: the list of subscriptions and a single subscription read', [
      'GET /domains/{}/subscriptions/list',
      'GET /subscriptions/{}',
    ]),
    ...freeOf('e-mail address checks: the address named receives a fixed test message through the SMTP server named, with no message content', [
      'GET /domains/{}/users/{}/email/checkVerified/{}',
      'POST /email/validate',
    ]),
    ...freeOf('speech-word vocabulary uploads: recognition hints an administrator supplies, not call content', [
      'POST /domains/{}/speech-words/{}/upload',
      'POST /speech-words/{}/upload',
    ]),
    ...freeOf('speech-word vocabulary: recognition hints an administrator uploads or reads back, not call content', [
      'GET /domains/{}/speech-words',
      'GET /domains/{}/speech-words/{}',
      'GET /speech-words',
      'GET /speech-words/{}',
      'PUT /domains/{}/speech-words/{}',
      'PUT /speech-words/{}',
    ]),
    ...freeOf('v1 call control: hold, park, disconnect, reject and recording switches on a live call; no call content is returned, and a recording switch is enablement (a documented limit)', [
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
    ]),
    ...freeOf('live call state and counts: the active call carries addresses and states, with no content', [
      'v1:call:count',
      'v1:call:read',
      'v1:callidemgr:read',
    ]),
    ...freeOf('call queue settings: the agents, callbacks and overflow forwards a queue uses, which receive live calls (a documented limit) and no call content; its recording configuration is enablement', [
      'v1:callqueue:create',
      'v1:callqueue:delete',
      'v1:callqueue:read',
      'v1:callqueue:update',
    ]),
    ...freeOf('queue e-mail report schedules: which statistics go to which address, not call content', [
      'v1:callqueueemailreport:create',
      'v1:callqueueemailreport:delete',
      'v1:callqueueemailreport:read',
      'v1:callqueueemailreport:update',
    ]),
    ...freeOf('queue statistics: counts and averages, not call content', ['v1:callqueuereport:read', 'v1:callqueuestat:read']),
    ...freeOf('wake-up call requests: reads and cancels, with no call content', [
      'v1:callrequest:delWakeUp',
      'v1:callrequest:read',
    ]),
    ...freeOf('v1 file uploads: the server stores the file and returns no content', ['v1:upload:create', 'v1:upload:upload']),
    ...freeOf('pictures and templates with a signed link: the link is a picture or template, not one of the six kinds', [
      'GET /images/{}',
      'GET /templates/{}',
    ]),
    ...freeOf('pictures and templates an administrator uploads, deletes or updates: the server a picture or template is stored on, which receives the file and no content of one of the six kinds', [
      'DELETE /images/{}',
      'POST /images/{}',
      'POST /templates/{}',
      'PUT /images/{}',
      'PUT /templates/{}',
    ]),
    ...freeOf('brand asset records: a picture and its signed link, not one of the six kinds', [
      'GET /domains/{}/brands/{}/{}/assets',
      'GET /domains/{}/brands/{}/{}/assets/{}',
      'GET /resellers/{}/brands/{}/{}/assets',
      'GET /resellers/{}/brands/{}/{}/assets/{}',
    ]),
    ...freeOf('images and brand assets: pictures an administrator uploads, not one of the six kinds', [
      'GET /avatar/{}',
      'GET /avatar/{}/{}',
      'GET /deviceprofiles/image/{}/{}',
      'GET /domains/{}/brands/{}/{}/assets/{}/download',
      'GET /oidc-providers/{}/logo',
      'GET /resellers/{}/brands/{}/{}/assets/{}/download',
    ]),
    ...freeOf('speech-word and voice audio: recognition vocabulary and the text-to-speech voice a user sets, which receive no call content', [
      'GET /domains/{}/speech-words/{}/file',
      'GET /domains/{}/speech-words/{}/play',
      'GET /domains/{}/users/{}/voices',
      'GET /speech-words/{}/file',
      'GET /speech-words/{}/play',
      'POST /domains/{}/users/{}/voices',
    ]),
    ...freeOf('device provisioning files (text and XML): the device settings, not one of the six kinds; see the report on credentials', [
      'GET /domains/{}/phones/{}/config',
      'GET /phones/{}/config',
    ]),
    ...freeOf('system maintenance and health output: plain text status, not call content', [
      'DELETE /apt/repos/{}/{}',
      'GET /ipaware/{}/healthz',
      'POST /apt/autoremove/{}',
      'POST /apt/dist-upgrade/{}',
      'POST /apt/install/{}',
      'POST /apt/repos/{}/{}',
      'POST /apt/update',
      'POST /apt/update/{}',
    ]),
    ...freeOf('brand and restore settings: the host and sender names that links and mail use, which receive no content', [
      'POST /brand-defaults',
      'POST /brand-defaults/{}',
      'POST /domains/{}/brands',
      'POST /domains/{}/brands/{}/{}/copy',
      'POST /resellers/{}/brands',
      'POST /resellers/{}/brands/{}/{}/copy',
      'PUT /domains/{}/brands/{}/{}',
      'PUT /resellers/{}/brands/{}/{}',
      'PUT /domains/{}/restore',
      'PUT /restore',
    ]),
    ...freeOf('server and provisioning settings: the host names, settings and login details that phones and servers are reached with, which receive no call or message content', [
      'DELETE /configurations/{}',
      'POST /config-definitions',
      'POST /configurations',
      'POST /domains/{}/provisioning-defaults',
      'POST /domains/{}/sites/{}/provisioning-defaults',
      'POST /nmsconfig',
      'POST /nsconfigs',
      'POST /phones/servers',
      'PUT /config-definitions/{}',
      'PUT /configurations',
      'PUT /configurations/{}',
      'PUT /nmsconfig/{}',
      'PUT /nsconfigs',
      'PUT /phones/servers/{}',
    ]),
    ...freeOf('phone and device provisioning: the servers, SIP registrations and button targets a phone receives, and no call or message content; device recording and notification switches are enablement', [
      'POST /domains/{}/phones',
      'POST /domains/{}/users/{}/devices',
      'POST /phones',
      'PUT /domains/{}/phones',
      'PUT /domains/{}/users/{}/devices/{}',
      'PUT /phones',
    ]),
    ...freeOf('IP, emergency and 911 address records: the addresses the platform matches or stores, which receive no content; an emergency callback number is live audio (a documented limit)', [
      'DELETE /domains/{}/addresses/endpoints/{}',
      'DELETE /domains/{}/addresses/{}',
      'DELETE /domains/{}/users/{}/addresses/{}',
      'POST /domains/{}/addresses',
      'POST /domains/{}/addresses/endpoints',
      'POST /domains/{}/users/{}/addresses',
      'POST /ipaware/{}/allowed_ips',
      'POST /ipaware/{}/allowed_ips/remove',
      'POST /ipaware/{}/firewall/block',
      'POST /ipaware/{}/firewall/unblock',
      'PUT /domains/{}/addresses/endpoints/{}',
      'PUT /domains/{}/addresses/{}',
      'PUT /domains/{}/users/{}/addresses/{}',
    ]),
    ...freeOf('SIP connections, dial rules, call routes and number routing, a documented limit: a call is signalled, translated and sent to the host or user it names, which receives live audio, not one of the six kinds', [
      'DELETE /domains/{}/connections/{}',
      'POST /connections',
      'POST /dialplans/{}/dialrules',
      'POST /domains/{}/connections',
      'POST /domains/{}/dialplans/{}/dialrules',
      'POST /domains/{}/routeprofiles',
      'POST /routecon',
      'POST /routes',
      'POST /routes/{}/routecon',
      'PUT /connections/{}',
      'PUT /dialplans/{}/dialrules/{}',
      'PUT /domains/{}/connections/{}',
      'PUT /domains/{}/dialplans/{}/dialrules/{}',
      'PUT /domains/{}/routeprofiles/{}',
      'PUT /routecon',
      'PUT /routeprofiles/{}',
      'PUT /routes',
      'PUT /routes/{}',
      'PUT /routes/{}/routecon/{}',
    ]),
    ...freeOf('network test targets: the hosts a network test probes, which receive probe traffic and no content', [
      'POST /domains/{}/networktests',
      'POST /domains/{}/users/{}/networktests',
    ]),
    ...freeOf('single sign-on provider endpoints: the URLs the platform calls to sign users in, which receive a sign-in request and no content', [
      'POST /domains/{}/oidc-providers',
      'POST /oidc-providers',
      'POST /oidc-providers/verify',
      'PUT /domains/{}/oidc-providers/{}',
      'PUT /oidc-providers/{}',
    ]),
    ...freeOf('address book and site records: the e-mail addresses and phone numbers a contact or site holds, which are looked up and receive nothing', [
      'POST /domains/{}/contacts',
      'POST /domains/{}/sites',
      'POST /domains/{}/users/{}/contacts',
      'POST /domains/{}/users/{}/host/contacts',
      'PUT /domains/{}/contacts/{}',
      'PUT /domains/{}/sites/{}',
      'PUT /domains/{}/users/{}/contacts/{}',
    ]),
    ...freeOf('UI extension registry and settings: the web addresses and bucket paths an extension loads from, which receive no content (callback payloads are unverified)', [
      'POST /ui-extensions/registry',
      'POST /ui-extensions/registry/{}/access',
      'POST /ui-extensions/registry/{}/deploy',
      'PUT /ui-extensions/registry/{}',
      'PUT /ui-extensions/registry/{}/access/{}',
      'PUT /ui-extensions/settings',
    ]),
    ...freeOf('number filters: the numbers a user or domain rejects, which receive nothing but the list', [
      'DELETE /domains/{}/number-filters',
      'DELETE /domains/{}/users/{}/number-filters',
      'POST /domains/{}/number-filters',
      'POST /domains/{}/users/{}/number-filters',
    ]),
    ...freeOf('video service records: the host and domain video settings, and the removal of a host, not recording or message content', [
      'DELETE /domains/{}/users/{}/host',
      'DELETE /domains/{}/video',
      'PUT /domains/{}/video',
    ]),
    ...freeOf('answer rules: the order of call routing rules, not content', ['PUT /domains/{}/users/{}/answerrules/reorder']),
    ...freeOf('live call control, a documented limit: the destination of a call, transfer, answer, forward, queue or participant receives live audio, which is not one of the six kinds; protected only by access read', [
      'PATCH /domains/{}/users/{}/calls/{}/answer',
      'PATCH /domains/{}/users/{}/calls/{}/transfer',
      'PATCH /domains/{}/users/{}/calls/{}/transferPeer',
      'POST /domains/{}/queuedcall/{}',
      'POST /domains/{}/users/{}/calls/{}/{}',
      'POST /domains/{}/conferences/{}/participants',
      'PUT /domains/{}/conferences/{}/participants/{}',
      'POST /domains/{}/users/{}/video/conference',
      'POST /domains/{}/users/{}/answerrules',
      'PUT /domains/{}/users/{}/answerrules/{}',
      'POST /domains/{}/users/{}/calls',
      'v1:call:answer',
      'v1:call:call',
      'v1:call:call_to_playback',
      'v1:call:call_to_record',
      'v1:call:xfer',
      'v1:call:xfer_peer',
      'v1:callrequest:addWakeUp',
      'v1:queuedcall:create',
      'v1:participant:create',
    ]),
    ...freeOf('deletes and writes that return text or a status: no content is returned', [
      'DELETE /domains/{}',
      'DELETE /domains/{}/users/{}/calls/{}/reject',
      'DELETE /resellers/{}',
    ]),
    ...freeOf('interface translations: the product copy of the UI, not one of the six kinds', [
      'DELETE /translations',
      'POST /translations',
      'POST /translations/sync-filesystem',
      'PUT /translations',
    ]),
    ...freeOf('SIP connections, dial rules, call routes and number routing, a documented limit: a call is signalled, translated and sent to the host or user it names, which receives live audio, not one of the six kinds', [
      'v1:connection:create',
      'v1:connection:update',
      'v1:dialrule:create',
      'v1:dialrule:update',
      'v1:phonenumber:create',
      'v1:phonenumber:update',
      'v1:route:create',
      'v1:route:delete',
      'v1:route:update',
      'v1:routecon:create',
      'v1:routecon:delete',
      'v1:routecon:update',
    ]),
    ...freeOf('server and provisioning settings: the host names, settings and login details that phones and servers are reached with, which receive no call or message content', ['POST /ndpconfig', 'PUT /ndpconfig/{}']),
    ...freeOf('IP, emergency and 911 address records: the addresses the platform matches or stores, which receive no content; an emergency callback number is live audio (a documented limit)', [
      'POST /domains/{}/addresses/validate',
      'v1:address:copyEndpoint',
      'v1:address:create',
      'v1:address:createAddressEndpoint',
      'v1:address:delete',
      'v1:address:deleteAddressEndpoint',
      'v1:address:duplicate',
      'v1:address:update',
    ]),
    ...freeOf('address book and site records: the e-mail addresses and phone numbers a contact or site holds, which are looked up and receive nothing', ['v1:contact:create', 'v1:contact:update']),
    ...freeOf('phone and device provisioning: the servers, SIP registrations and button targets a phone receives, and no call or message content; device recording and notification switches are enablement', [
      'POST /domains/{}/phoneconfiguration',
      'POST /domains/{}/phonetemplates',
      'PUT /domains/{}/phoneconfiguration/{}',
      'PUT /domains/{}/phonetemplates/{}',
      'v1:device:update',
      'v1:mac:create',
      'v1:mac:update',
    ]),
    ...freeOf('the billing account code of a call record: it receives a label for billing, not call content', [
      'PUT /cdrs/{}',
      'PUT /domains/{}/cdrs/{}',
      'PUT /domains/{}/users/{}/cdrs/{}',
    ]),
    ...freeOf('an agent status log entry: the log receives a status line about the agent, not content', ['v1:agentlog:create']),
    ...freeOf('a time range that a routing rule applies at set times: it receives the dates and times only, not content', ['v1:timerange:create', 'v1:timerange:update']),
    ...freeOf('user-interface configuration: a host name that a setting names, which receives nothing but the setting, not content', ['v1:uiconfig:create', 'v1:uiconfigdef:create']),
    ...freeOf('call queue settings: the agents, callbacks and overflow forwards a queue uses, which receive live calls (a documented limit) and no call content; its recording configuration is enablement', [
      'POST /domains/{}/callqueues',
      'PUT /domains/{}/callqueues/{}',
    ]),
  ]),
);

/**
 * Response names the gate matches that one operation reviews by name, each with a reason. Each group names the operations,
 * the response names they reviewed, and the reason. A free listing alone never silences such a name.
 */
function nameReviews(
  ...groups: ReadonlyArray<readonly [readonly string[], readonly string[], string]>
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [keys, names, reason] of groups) {
    for (const key of keys) {
      const current = out[key] ?? {};
      for (const name of names) current[name] = reason;
      out[key] = current;
    }
  }
  return Object.freeze(out);
}

/** The status-envelope operations whose response carries a message field on the older releases (the 45 that are not sends). */
const STATUS_MESSAGE_KEYS = [
  'DELETE /configurations/{}',
  'DELETE /domains/{}/addresses/endpoints/{}',
  'DELETE /domains/{}/addresses/{}',
  'DELETE /domains/{}/conferences/{}',
  'DELETE /domains/{}/conferences/{}/participants/{}',
  'DELETE /domains/{}/connections/{}',
  'DELETE /domains/{}/number-filters',
  'DELETE /domains/{}/smsnumbers/{}',
  'DELETE /domains/{}/users/{}/addresses/{}',
  'DELETE /domains/{}/users/{}/host',
  'DELETE /domains/{}/users/{}/messagesessions/{}',
  'DELETE /domains/{}/users/{}/number-filters',
  'DELETE /domains/{}/users/{}/vmailnag',
  'DELETE /domains/{}/video',
  'DELETE /domains/{}/video/subscription/{}',
  'DELETE /images/{}',
  'GET /fax/vendors',
  'POST /configurations',
  'POST /domains/{}/addresses/endpoints',
  'POST /domains/{}/conferences/{}/participants',
  'POST /domains/{}/number-filters',
  'POST /domains/{}/smsnumbers',
  'POST /domains/{}/users/{}/host',
  'POST /domains/{}/users/{}/host/contacts',
  'POST /domains/{}/users/{}/number-filters',
  'POST /domains/{}/users/{}/video/conference',
  'POST /domains/{}/video/subscription/{}',
  'POST /images/{}',
  'POST /templates/{}',
  'POST /ui-extensions/registry/{}/deploy',
  'PUT /configurations',
  'PUT /domains/{}/addresses/endpoints/{}',
  'PUT /domains/{}/addresses/{}',
  'PUT /domains/{}/conferences/{}',
  'PUT /domains/{}/conferences/{}/participants/{}',
  'PUT /domains/{}/smsnumbers/{}',
  'PUT /domains/{}/users/{}/addresses/{}',
  'PUT /domains/{}/users/{}/answerrules/reorder',
  'PUT /domains/{}/users/{}/host',
  'PUT /domains/{}/users/{}/messagesessions/{}',
  'PUT /domains/{}/users/{}/messagesessions/{}/leave',
  'PUT /domains/{}/video',
  'PUT /domains/{}/video/subscriptions',
  'PUT /images/{}',
  'PUT /templates/{}',
];

/**
 * Response names the gate matches that one operation reviews by name, each with a reason. A name a classified field or
 * the setting whitelist already explains needs no entry here.
 */
export const NAME_REVIEWS: Readonly<Record<string, Readonly<Record<string, string>>>> = nameReviews(
  [
    ['GET /domains/{}/brands/{}/{}/assets', 'GET /domains/{}/brands/{}/{}/assets/{}', 'GET /resellers/{}/brands/{}/{}/assets', 'GET /resellers/{}/brands/{}/{}/assets/{}', 'GET /images/{}', 'GET /templates/{}'],
    ['file-access-url'],
    'a signed link to a brand asset, picture or template an administrator uploads: not one of the six kinds',
  ],
  [
    ['GET /images/{}', 'GET /templates/{}'],
    ['file-access-url '],
    'a signed link to an uploaded picture or template, with the trailing space the spec gives it: not one of the six kinds',
  ],
  [
    ['GET /domains/{}/cdrs/{}/sipflow', 'GET /domains/{}/sipflow/{}', 'GET /sipflow', 'GET /sipflow/{}'],
    ['media', 'ts_text'],
    "a SIP trace field: a media description or a timestamp label, covered by this trace operation's sms_text listing, since a SIP MESSAGE body can appear in a trace",
  ],
  [
    ['GET /domains/{}/conferences/{}/participants', 'GET /domains/{}/conferences/{}/participants/{}'],
    ['media'],
    "a conference participant's media description (codecs and addresses): call setup, not call content",
  ],
  [
    ['GET /domains/{}/speech-words', 'GET /domains/{}/speech-words/{}', 'GET /speech-words', 'GET /speech-words/{}', 'PUT /domains/{}/speech-words/{}', 'PUT /speech-words/{}'],
    ['media-path'],
    'the path of an uploaded speech-word file: a file location, not call content',
  ],
  [
    ['GET /domains/{}/messagesessions', 'GET /domains/{}/users/{}/messagesessions', 'GET /domains/{}/users/{}/messagesessions/{}'],
    [
      'messagesession-agent-start-datetime',
      'messagesession-last-datetime',
      'messagesession-last-email-reminder-datetime',
      'messagesession-last-media-size',
      'messagesession-last-media-type',
      'messagesession-last-sender',
      'messagesession-last-status',
      'messagesession-last-type',
      'messagesession-muted',
      'messagesession-name',
      'messagesession-queue-session-id',
      'messagesession-queue-status',
      'messagesession-queue-termination',
      'messagesession-remote',
      'messagesession-sms-number',
      'messagesession-start-datetime',
      'messagesession-type',
      'messagesession-participants',
      'messagesession-reciever-hostname',
    ],
    'a message session field: a time, status, type, sender, queue or participant detail, not message text; the last message is stripped by field',
  ],
  [
    ['GET /domains/{}/users/{}/messagesessions/{}/messages', 'POST /domains/{}/users/{}/messages'],
    ['messagesession-participants', 'messagesession-reciever-hostname', 'messagesession-id', 'media-size', 'media-type'],
    'session and attachment metadata on a message this operation returns as sms_text: identifiers, sizes and participants, not message text',
  ],
  [
    ['DELETE /translations', 'POST /translations', 'POST /translations/sync-filesystem', 'PUT /translations'],
    ['summary'],
    'a translation sync summary: counts of keys changed, not content',
  ],
  [
    ['GET /sipflow/events'],
    ['event-text'],
    "a SIP trace event text that can carry a message body: covered by this trace operation's sms_text listing",
  ],
  [
    ['GET /domains/{}/transcriptions'],
    ['sentiment'],
    "a sentiment label on a transcription segment: analysis output, covered by this operation's ai_summary listing",
  ],
  [
    ['GET /recordings/entries', 'GET /recordings/servers/{}/entries'],
    ['sentiment', 'transcription'],
    'a yes or no switch on a recording entry, whether it gets sentiment analysis or transcription: not analysis output or a transcript',
  ],
  [
    ['GET /domains/{}/recordings/{}', 'GET /domains/{}/users/{}/recordings/{}'],
    [
      'call-recording-ended-datetime',
      'call-recording-match-pattern',
      'call-recording-remote-storage-config-id',
      'call-recording-remote-wav-size-kilobytes',
      'call-recording-retrieved-datetime',
      'call-recording-started-datetime',
    ],
    'call recording metadata: times, size, match pattern and storage identifier; the recording link itself is classified call_recording',
  ],
  [
    ['GET /smscarriers', 'GET /smscarriers/{}'],
    ['inbound-media-field', 'inbound-text', 'outbound-media-field', 'outbound-media-keep-text', 'outbound-text'],
    'an SMS carrier setting for media or text in one direction: a switch or field, not message content',
  ],
  [
    [
      'DELETE /domains/{}/users/{}/autoattendants/{}',
      'GET /domains/{}/autoattendants',
      'GET /domains/{}/moh/{}',
      'GET /domains/{}/msg/{}',
      'GET /domains/{}/users/{}/autoattendants/{}',
      'GET /domains/{}/users/{}/moh/{}',
      'GET /domains/{}/users/{}/msg/{}',
      'POST /domains/{}/autoattendants',
      'POST /domains/{}/msg',
      'POST /domains/{}/users/{}/greetings',
      'POST /domains/{}/users/{}/msg',
      'PUT /domains/{}/msg/{}',
      'PUT /domains/{}/users/{}/autoattendants/{}',
      'PUT /domains/{}/users/{}/greetings/{}',
      'PUT /domains/{}/users/{}/msg/{}',
    ],
    ['file-access-url'],
    'a signed link to a greeting, prompt or auto-attendant audio file: administrator or owner audio, not caller content; the operation is voicemail for its script text',
  ],
  [
    STATUS_MESSAGE_KEYS.filter((key) => key !== 'POST /domains/{}/users/{}/messagesessions/{}/messages'),
    ['message'],
    'a status message in this operation\'s response, the envelope of an older release or a result line: a label, not record content',
  ],
  [
    ['POST /domains/{}/users/{}/messagesessions/{}/messages'],
    ['message'],
    "the message this operation sends and returns, whose text is sms_text: covered by this operation's sms_text listing",
  ],
);

/** The sets together, so the gate test and the lookups read one value. */
export interface ContentOperationTable {
  readonly kinds: Readonly<Record<ContentKind, Readonly<Record<string, true>>>>;
  readonly unreviewed: Readonly<Record<string, true>>;
  readonly records: Readonly<Record<string, RecordListEntry>>;
  readonly free: Readonly<Record<string, string>>;
  readonly names: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export const CONTENT_OPERATION_TABLE: ContentOperationTable = {
  kinds: CONTENT_OPERATIONS,
  unreviewed: UNREVIEWED_CONTENT_OPERATIONS,
  records: RECORD_LIST_OPERATIONS,
  free: REVIEWED_CONTENT_FREE,
  names: NAME_REVIEWS,
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
 * The kinds the gate requires an operation to be listed under: every kind a set lists it with, every kind a record list
 * carries, all kinds when it is unreviewed, none when it is reviewed as free, and undefined when no set lists it.
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
 * The key of a v1 registry operation, such as "GET ?object=audio&action=play". Undefined when the registry key carries no
 * object and action.
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
export function contentCoverage(current: Iterable<string>, table: ContentOperationTable = CONTENT_OPERATION_TABLE): ContentCoverage {
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
