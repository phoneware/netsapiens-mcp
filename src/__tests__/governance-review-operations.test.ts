import { describe, expect, it } from 'vitest';
import { CONTENT_KINDS } from '../access/contract.js';
import { getToolCatalogView } from '../access/groups.js';
import { compilePolicy, type CompiledPolicy } from '../access/policy.js';
import { contentKindsOf } from '../governance/content-operations.js';
import { NS_RESOURCE_FIELDS } from '../governance/ns-fields.generated.js';
import { projectOutput, resourceDeclaration } from '../governance/scrub.js';
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
