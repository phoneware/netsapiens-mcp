import { describe, expect, it } from 'vitest';
import { CONTENT_KINDS } from '../access/contract.js';
import { getToolCatalogView } from '../access/groups.js';
import { compilePolicy, type CompiledPolicy } from '../access/policy.js';
import { contentKindsOf, REVIEWED_CONTENT_FREE } from '../governance/content-operations.js';
import { NS_RESOURCE_FIELDS } from '../governance/ns-fields.generated.js';
import { projectOutput, resourceDeclaration, scrubSecrets } from '../governance/scrub.js';
import type { ContentKind, FieldClass } from '../governance/types.js';

/** A write-capable policy that denies exactly the given kinds and allows everything else. */
function denying(...deny: ContentKind[]): CompiledPolicy {
  const content = Object.fromEntries(CONTENT_KINDS.map((kind) => [kind, deny.includes(kind) ? 'deny' : 'allow'])) as Record<
    ContentKind,
    'deny' | 'allow'
  >;
  return compilePolicy(
    {
      tools: { allow: ['*'], deny: [] },
      access: 'write',
      content,
      unclassifiedOutput: 'allow',
      platforms: ['*'],
    },
    getToolCatalogView(),
    'review',
  );
}

const v2 = (key: string) => ({ kind: 'v2' as const, method: key.split(' ')[0], key });
const v1 = (key: string) => ({ kind: 'v1' as const, action: key.split(':')[2], key });

/** The kinds an operation is listed under, as a set, or undefined when no set lists it. */
function kindSet(key: string): Set<ContentKind> | 'unreviewed' | undefined {
  const found = contentKindsOf(key);
  if (found === undefined || found === 'unreviewed') return found;
  return new Set(found);
}

function expectKinds(key: string, expected: readonly ContentKind[]): void {
  expect(kindSet(key), key).toEqual(new Set(expected));
}

function expectIncludes(key: string, expected: readonly ContentKind[]): void {
  const found = kindSet(key);
  expect(found, key).not.toBe(undefined);
  expect(found, key).not.toBe('unreviewed');
  for (const kind of expected) expect(found as Set<ContentKind>, `${key} lists ${kind}`).toContain(kind);
}

describe('review finding 1: event subscriptions transmit content', () => {
  const TRANSMIT_KINDS: readonly ContentKind[] = ['sms_text', 'voicemail', 'transcript', 'ai_summary'];

  it.each([
    'POST /subscriptions',
    'PUT /subscriptions/{}',
    'POST /domains/{}/subscriptions',
    'PUT /domains/{}/subscriptions/{}',
    'v1:event:create',
  ])('%s is listed under sms_text, voicemail, transcript and ai_summary', (key) => {
    expectKinds(key, TRANSMIT_KINDS);
  });

  it('refuses a subscription create under an sms_text deny, as the reviewer demonstrated', () => {
    expect(denying('sms_text').operationDecision(v2('POST /subscriptions'))).toEqual({
      allowed: false,
      reason: 'content:sms_text',
    });
  });

  it('lists subscription settings reads and removals as content-free', () => {
    expect(kindSet('GET /subscriptions')).toBe(undefined);
    expect(kindSet('GET /domains/{}/subscriptions')).toBe(undefined);
    expect(kindSet('v1:event:read')).toBe(undefined);
    expect(kindSet('v1:event:delete')).toBe(undefined);
  });
});

describe('review finding 2: voicemail reads and changes carry transcripts', () => {
  it.each([
    'GET /domains/{}/users/{}/voicemails/{}/{}',
    'PATCH /domains/{}/users/{}/voicemails/{}/{}/save',
    'PATCH /domains/{}/users/{}/voicemails/{}/{}/forward',
    'DELETE /domains/{}/users/{}/voicemails/{}/{}',
    'GET /domains/{}/users/{}/voicemails/{}',
  ])('%s includes voicemail and transcript', (key) => {
    expectIncludes(key, ['voicemail', 'transcript']);
  });

  it('lists the voicemail folder list as fax_page as well, since folders hold faxes', () => {
    expectIncludes('GET /domains/{}/users/{}/voicemails/{}', ['fax_page']);
  });

  it('refuses the voicemail folder list under a transcript deny', () => {
    expect(denying('transcript').operationDecision(v2('GET /domains/{}/users/{}/voicemails/{}'))).toEqual({
      allowed: false,
      reason: 'content:transcript',
    });
  });
});

describe('review finding 3: v1 audio by its real kinds', () => {
  it.each(['v1:audio:read', 'v1:audio:play'])('%s is call_recording, voicemail, fax_page and transcript', (key) => {
    expectKinds(key, ['call_recording', 'voicemail', 'fax_page', 'transcript']);
  });

  it.each(['v1:audio:update', 'v1:audio:link_update', 'v1:audio:link_delete'])(
    '%s changes voicemail routing, so it is voicemail',
    (key) => {
      expectKinds(key, ['voicemail']);
    },
  );

  it('refuses a v1 audio read under a voicemail deny', () => {
    expect(denying('voicemail').operationDecision(v1('v1:audio:read'))).toEqual({ allowed: false, reason: 'content:voicemail' });
  });

  it('refuses a v1 audio update that forwards voicemail under a voicemail deny', () => {
    expect(denying('voicemail').operationDecision(v1('v1:audio:update'))).toEqual({ allowed: false, reason: 'content:voicemail' });
  });

  it('keeps counts, uploads and deletes content-free', () => {
    expect(kindSet('v1:audio:count')).toBe(undefined);
    expect(kindSet('v1:audio:upload')).toBe(undefined);
    expect(kindSet('v1:audio:delete')).toBe(undefined);
  });
});

describe('review finding 4: v1 message session reads return the last message text', () => {
  it('lists v1:messagesession:read under sms_text only', () => {
    expectKinds('v1:messagesession:read', ['sms_text']);
  });

  it('refuses it under an sms_text deny', () => {
    expect(denying('sms_text').operationDecision(v1('v1:messagesession:read'))).toEqual({
      allowed: false,
      reason: 'content:sms_text',
    });
  });
});

describe('review finding 6: vCon fields carry their real kinds', () => {
  const vcon = NS_RESOURCE_FIELDS.Vcon;

  it('classifies the recording dialog, the analysis, the subject and the CDR attachments', () => {
    expect(vcon.dialog).toEqual({ class: 'content', kind: 'call_recording', media: 'audio_url' });
    expect(vcon.analysis).toEqual({ class: 'content', kind: 'transcript', media: 'text', alsoKinds: ['ai_summary'] });
    expect(vcon.subject).toEqual({ class: 'content', kind: 'ai_summary', media: 'text' });
    expect(vcon.attachments).toEqual({ class: 'content', kind: 'ai_summary', media: 'text', alsoKinds: ['transcript'] });
  });

  it('leaves identifiers, timestamps, parties and the platform block as metadata', () => {
    for (const name of ['uuid', 'created_at', 'updated_at', 'extensions', 'parties', 'x-netsapiens']) {
      expect(vcon[name], name).toEqual({ class: 'metadata' });
    }
  });

  const payload = {
    uuid: 'v-1',
    subject: 'Caller asked about a refund.',
    dialog: [{ type: 'recording', url: 'https://example.invalid/rec.wav' }],
    analysis: [{ type: 'transcript', body: 'hello there' }],
    attachments: [{ body: { 'call-intelligence-summary': 'short summary' } }],
    parties: [{ name: 'A' }],
  };

  it('removes the analysis and the attachments under a transcript strip, and keeps the subject', () => {
    const result = projectOutput(payload, resourceDeclaration('Vcon'), { stripKinds: ['transcript'] });
    expect(result.projected).not.toHaveProperty('analysis');
    expect(result.projected).not.toHaveProperty('attachments');
    expect(result.projected).toHaveProperty('subject');
    expect(result.stripped.transcript).toBe(2);
  });

  it('removes the subject, the analysis and the attachments under an ai_summary strip', () => {
    const result = projectOutput(payload, resourceDeclaration('Vcon'), { stripKinds: ['ai_summary'] });
    expect(result.projected).not.toHaveProperty('subject');
    expect(result.projected).not.toHaveProperty('analysis');
    expect(result.projected).not.toHaveProperty('attachments');
    expect(result.stripped.ai_summary).toBe(3);
  });

  it('removes the recording dialog under a call_recording strip', () => {
    const result = projectOutput(payload, resourceDeclaration('Vcon'), { stripKinds: ['call_recording'] });
    expect(result.projected).not.toHaveProperty('dialog');
    expect(result.stripped.call_recording).toBe(1);
  });
});

describe('review finding 7: voicemail transcript text', () => {
  it('classifies file-transcript-text on the voicemail message and the curated voicemail as transcript', () => {
    const expected: FieldClass = { class: 'content', kind: 'transcript', media: 'text' };
    expect(NS_RESOURCE_FIELDS.VoicemailMessage['file-transcript-text']).toEqual(expected);
    expect(NS_RESOURCE_FIELDS.Voicemail['file-transcript-text']).toEqual(expected);
  });

  it('strips the transcript text under a transcript strip', () => {
    const result = projectOutput(
      { filename: 'v1.wav', 'file-transcript-text': 'call me back about the invoice' },
      resourceDeclaration('VoicemailMessage'),
      { stripKinds: ['transcript'] },
    );
    expect(result.projected).toEqual({ filename: 'v1.wav' });
    expect(result.stripped.transcript).toBe(1);
  });
});

describe('review finding 10: call-intelligence sentiment fields are derived from transcripts', () => {
  const SENTIMENT_DERIVED = /^call-intelligence-(ending-)?(percent|duration-seconds)-(negative|neutral|positive)$|^call-intelligence-ending-sentiment-scale$/;
  const CDR_RESOURCES = ['CdrD', 'CdrDBase', 'CdrU', 'CdrUBase', 'CdrG', 'CdrGBase'];

  it('classifies every sentiment-derived CDR field as ai_summary', () => {
    let seen = 0;
    for (const resource of CDR_RESOURCES) {
      for (const [name, cls] of Object.entries(NS_RESOURCE_FIELDS[resource] ?? {})) {
        if (!SENTIMENT_DERIVED.test(name)) continue;
        seen += 1;
        expect(cls, `${resource}.${name}`).toEqual({ class: 'content', kind: 'ai_summary', media: 'text' });
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('classifies the transcription sentiment fields as ai_summary', () => {
    expect(NS_RESOURCE_FIELDS.Transcription['call-intelligence-ending-sentiment-scale']).toEqual({
      class: 'content',
      kind: 'ai_summary',
      media: 'text',
    });
  });

  it('reviews every call-intelligence field: content, or a named metadata field', () => {
    const REVIEWED_METADATA = new Set(['call-intelligence-job-id', 'call-intelligence-features-enabled', 'call-intelligence-processing-status', 'call-intelligence-summary-status', 'call-intelligence-duration-seconds', 'call-intelligence-ending-duration-seconds']);
    const unreviewed: string[] = [];
    for (const table of Object.values(NS_RESOURCE_FIELDS)) {
      for (const [name, cls] of Object.entries(table)) {
        if (!name.startsWith('call-intelligence-') || cls.class !== 'metadata') continue;
        if (!REVIEWED_METADATA.has(name)) unreviewed.push(name);
      }
    }
    expect([...new Set(unreviewed)]).toEqual([]);
  });
});

describe('review finding 12: unverified items are decided conservatively', () => {
  it('v1 recording reads may return transcription or sentiment text', () => {
    expectKinds('v1:recording:read', ['call_recording', 'transcript', 'ai_summary']);
  });

  it('v1 conversation reads mix voicemail, call and chat records, so every kind applies', () => {
    expectKinds('v1:conversation:read', [...CONTENT_KINDS]);
  });

  it('a meeting join token may also authorize recording playback, so the token is call_recording', () => {
    expectKinds('POST /domains/{}/users/{}/meetings/{}/sfu', ['call_recording']);
    expectKinds('GET /domains/{}/users/{}/meetings/{}/sfu', ['call_recording']);
  });

  it('v1 subscriber create and update set voicemail forwarding, and the address that receives transcripts and fax', () => {
    expectKinds('v1:subscriber:create', ['transcript', 'voicemail', 'fax_page']);
    expectKinds('v1:subscriber:update', ['transcript', 'voicemail', 'fax_page']);
    expect(denying('voicemail').operationDecision(v1('v1:subscriber:update'))).toEqual({
      allowed: false,
      reason: 'content:voicemail',
    });
  });

  it('user writes that set email copies of new voicemail, and voicemail reminders, are voicemail', () => {
    expectIncludes('POST /domains/{}/users', ['voicemail']);
    expectIncludes('PUT /domains/{}/users/{}', ['voicemail']);
    expectIncludes('POST /domains/{}/users/{}/vmailnag', ['voicemail']);
    expectIncludes('PUT /domains/{}/users/{}/vmailnag', ['voicemail']);
  });

  it('SIP trace reads and exports can carry SIP MESSAGE bodies, so they are sms_text', () => {
    for (const key of ['GET /sipflow/{}', 'GET /sipflow/download/{k}.txt', 'POST /sipflow/export', 'v1:trace:export']) {
      expectKinds(key, ['sms_text']);
    }
  });

  it('trace injection and share revocation do not return trace content', () => {
    expect(kindSet('POST /sipflow/event')).toBe(undefined);
    expect(kindSet('DELETE /sipflow/share/{}')).toBe(undefined);
  });

  it('CDR list operations stay usable under a deny: their fields are stripped, not the operation refused', () => {
    expect(kindSet('GET /domains/{}/cdrs')).toBe(undefined);
    expect(denying('ai_summary').operationDecision(v2('GET /domains/{}/cdrs'))).toEqual({ allowed: true });
  });
});

describe('round 3 finding 1: a call-trace share returns a tokenless key, so storing a trace is sms_text', () => {
  const STORE_OPERATIONS = ['POST /domains/{}/cdrs/{}/sipflow/store', 'POST /domains/{}/sipflow/{}/store', 'POST /sipflow/{}/store'];
  const SHARE = 'Union(CallTraceShare,CallTraceShareEnvelope)';
  const share = { success: true, data: { key: 'k-trace-7', expires: 2592000, callids: 'c1' } };

  it.each(STORE_OPERATIONS)('%s is sms_text', (key) => {
    expectKinds(key, ['sms_text']);
  });

  it('a deny of sms_text refuses every store operation', () => {
    for (const key of STORE_OPERATIONS) expect(denying('sms_text').operationDecision(v2(key)).allowed, key).toBe(false);
  });

  it('unset output keeps the key: the share key is registry-only, so scrubbing and an unrestricted projection leave it', () => {
    expect(scrubSecrets(share, resourceDeclaration(SHARE)).scrubbed).toEqual(share);
    expect(projectOutput(share, resourceDeclaration(SHARE)).projected).toEqual(share);
  });

  it('the share key is a content field of sms_text, so a registry that strips sms_text removes it', () => {
    expect(NS_RESOURCE_FIELDS.CallTraceShare.key).toEqual({ class: 'content', kind: 'sms_text', media: 'text' });
    const stripped = projectOutput(share, resourceDeclaration(SHARE), { stripKinds: ['sms_text'] });
    expect(stripped.projected).toEqual({ success: true, data: { expires: 2592000, callids: 'c1' } });
  });
});

describe('round 3 finding 2: writes that route SMS, push notifications or recordings', () => {
  it.each(['POST /smscarriers', 'PUT /smscarriers/{}', 'v1:smsnumber:create', 'v1:smsnumber:update'])(
    '%s is sms_text: a carrier URL or an inbound SMS destination receives the text',
    (key) => {
      expectKinds(key, ['sms_text']);
    },
  );

  it.each([
    'POST /push',
    'PUT /push',
    'DELETE /push',
    'POST /domains/{}/push',
    'PUT /domains/{}/push',
    'DELETE /domains/{}/push',
    'POST /domains/{}/users/{}/push',
    'PUT /domains/{}/users/{}/push',
    'DELETE /domains/{}/users/{}/push',
  ])('%s is sms_text and voicemail: a registration sets the device that receives notifications (payload unverified)', (key) => {
    expectKinds(key, ['sms_text', 'voicemail']);
  });

  it.each([
    'PUT /recordings/coreservers/{}',
    'POST /recordings/servers/{}/entries/sync',
    'POST /recordings/config',
    'PUT /recordings/config/{}',
    'POST /recordings/nmc-config',
    'PUT /recordings/nmc-config/{}',
  ])('%s is call_recording: it sets where call media or recordings are sent (free-form config is unverified)', (key) => {
    expectKinds(key, ['call_recording']);
  });

  it('reads and deletes of these settings stay free: they set no destination', () => {
    for (const key of ['GET /smscarriers', 'DELETE /smscarriers/{}', 'GET /recordings/config', 'DELETE /recordings/config/{}']) {
      expect(kindSet(key), key).toBe(undefined);
      expect(REVIEWED_CONTENT_FREE[key], key).toBeDefined();
    }
  });
});
