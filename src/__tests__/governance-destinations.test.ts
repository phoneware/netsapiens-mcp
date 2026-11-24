import { describe, expect, it } from 'vitest';
import { CONTENT_KINDS } from '../access/contract.js';
import { getToolCatalogView } from '../access/groups.js';
import { compilePolicy, type CompiledPolicy } from '../access/policy.js';
import { contentKindsOf, RECORD_LIST_OPERATIONS, REVIEWED_CONTENT_FREE } from '../governance/content-operations.js';
import { NS_RESOURCE_FIELDS } from '../governance/ns-fields.generated.js';
import { OPERATION_OUTPUTS } from '../governance/operation-outputs.generated.js';
import type { ContentKind } from '../governance/types.js';

/** A write-capable policy that denies exactly the given kinds. */
function denying(...deny: ContentKind[]): CompiledPolicy {
  const content = Object.fromEntries(CONTENT_KINDS.map((kind) => [kind, deny.includes(kind) ? 'deny' : 'allow'])) as Record<
    ContentKind,
    'deny' | 'allow'
  >;
  return compilePolicy(
    { tools: { allow: ['*'], deny: [] }, access: 'write', content, unclassifiedOutput: 'allow', platforms: ['*'] },
    getToolCatalogView(),
    'review',
  );
}

/** A v2 operation reference for a key such as "POST /domains/{}/schedule". */
function v2Write(key: string) {
  return { kind: 'v2' as const, method: key.split(' ')[0] ?? '', key };
}

/** Writes that set where scheduled CDR exports are sent: an e-mail address, or an SCP, FTP or SFTP server. */
const CDR_SCHEDULE_WRITES = [
  'POST /domains/{}/schedule',
  'PUT /domains/{}/schedule/{}',
  'POST /resellers/{}/schedule',
  'PUT /resellers/{}/schedule/{}',
  'POST /schedule',
  'PUT /schedule/{}',
  'v1:cdrschedule:create',
  'v1:cdrschedule:update',
];

/** Writes that set where call recordings are kept or sent: storage, recording servers and entries, and archives. */
const RECORDING_WRITES = [
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
];

/** Writes that send domain e-mail, including voicemail, transcripts and fax pages, through an SMTP relay. */
const SMTP_RELAY_WRITES = ['POST /domains', 'PUT /domains/{}', 'PUT /resellers/{}', 'v1:domain:update'];

/** Writes that set a user's e-mail address, which receives fax PDFs and voicemail transcripts. */
const USER_ADDRESS_WRITES = [
  'POST /domains/{}/users',
  'PUT /domains/{}/users/{}',
  'v1:subscriber:create',
  'v1:subscriber:update',
];

/** Writes that set where a fax number's inbound e-mail attachments go. */
const FAX_NUMBER_WRITES = [
  'POST /domains/{}/faxnumbers',
  'PUT /domains/{}/faxnumbers/{}',
  'PUT /domains/{}/users/{}/faxnumbers/{}',
];

/** Writes that move SMS to another user, session or number, or add a member to an inbox that receives it. */
const SMS_REDIRECT_WRITES = [
  'PUT /domains/{}/users/{}/messagesessions/{}',
  'PUT /domains/{}/users/{}/messagesessions/{}/accept',
  'PUT /domains/{}/smsnumbers/{}',
  'POST /domains/{}/inboxes/{}/smsnumbers',
  'POST /domains/{}/inboxes/{}/members',
  'v1:messagesession:update',
  'v1:messagesession:accept',
];

describe('round 2 finding 1: CDR schedule writes send call records off platform', () => {
  it.each(CDR_SCHEDULE_WRITES)('%s is transcript and ai_summary, as the export it configures', (key) => {
    expect(contentKindsOf(key)).toEqual(['transcript', 'ai_summary']);
  });

  it('refuses a schedule write under a transcript deny', () => {
    expect(denying('transcript').operationDecision(v2Write('POST /domains/{}/schedule'))).toEqual({
      allowed: false,
      reason: 'content:transcript',
    });
  });
});

describe('round 2 finding 2: recording storage, servers and entries receive call recordings', () => {
  it.each(RECORDING_WRITES)('%s is call_recording', (key) => {
    expect(contentKindsOf(key)).toEqual(['call_recording']);
  });

  it('keeps recording reads free, with a reason that no longer calls the writes settings', () => {
    expect(REVIEWED_CONTENT_FREE['GET /recordings/entries']).toBeDefined();
    expect(REVIEWED_CONTENT_FREE['GET /recordings/entries']).not.toMatch(/which addresses are recorded/);
    expect(Object.hasOwn(REVIEWED_CONTENT_FREE, 'PUT /recordings/entries')).toBe(false);
  });
});

describe('round 2 finding 3: redirect writes deliver the content they redirect', () => {
  it.each(SMTP_RELAY_WRITES)('%s relays voicemail, transcript and fax mail, so it is all three', (key) => {
    expect(contentKindsOf(key)).toEqual(['transcript', 'voicemail', 'fax_page']);
  });

  it.each(USER_ADDRESS_WRITES)('%s sets an address that receives voicemail, transcripts and fax', (key) => {
    expect(contentKindsOf(key)).toEqual(['transcript', 'voicemail', 'fax_page']);
  });

  it.each(FAX_NUMBER_WRITES)('%s sets where inbound fax e-mail goes, so it is fax_page', (key) => {
    expect(contentKindsOf(key)).toEqual(['fax_page']);
  });

  it.each(SMS_REDIRECT_WRITES)('%s redirects SMS, so it is sms_text', (key) => {
    expect(contentKindsOf(key)).toEqual(['sms_text']);
  });

  it('keeps leaving a message session free', () => {
    expect(contentKindsOf('PUT /domains/{}/users/{}/messagesessions/{}/leave')).toBeUndefined();
  });
});

describe('round 2 over-claimed record lists', () => {
  it('every record-list entry is backed by the classified fields of its output resource', () => {
    // Voicemail here comes from the script-text name file-script-text, which the projection strips by name and the resource
    // table does not declare. Only these keys skip the table check, and each must be voicemail only.
    const SCRIPT_TEXT_BACKED = [
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
    ];
    for (const [key, entry] of Object.entries(RECORD_LIST_OPERATIONS)) {
      if (SCRIPT_TEXT_BACKED.includes(key)) {
        expect(entry.kinds, key).toEqual(['voicemail']);
        continue;
      }
      expect(Object.hasOwn(OPERATION_OUTPUTS, key), `${key} has an output resource`).toBe(true);
      const resource = OPERATION_OUTPUTS[key];
      const backed = new Set<ContentKind>();
      for (const cls of Object.values(NS_RESOURCE_FIELDS[resource] ?? {})) {
        if (cls.class !== 'content') continue;
        backed.add(cls.kind);
        for (const also of cls.alsoKinds ?? []) backed.add(also);
      }
      for (const kind of entry.kinds) {
        expect(backed.has(kind), `${key} claims ${kind} but ${resource} does not classify it`).toBe(true);
      }
    }
  });
});
