import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// This repo is public and the live fixtures come from a real PBX. The first capture
// shipped real caller numbers, carrier IPs, a signed voicemail URL and a person's name in a
// SIP user. Every committed fixture must pass these checks; a recapture that leaks fails here.
const DIR = resolve(__dirname, 'fixtures/live');
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

const DOC_NETS = [/^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./, /^127\./, /^0\.0\.0\.0$/];

function leaks(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(?<![\w.])\+?1?([2-9]\d{2})([2-9]\d{6})(?![\w])/g)) {
    if (!m[2].startsWith('55501')) found.push(`phone ${m[0]}`);
  }
  for (const m of text.matchAll(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g)) {
    if (!DOC_NETS.some((n) => n.test(m[0]))) found.push(`ip ${m[0]}`);
  }
  for (const m of text.matchAll(/[?&](?:auth|token|key|sig|signature|access_token|apikey)=([^&#"\s]+)/gi)) {
    if (!/^0+$/.test(m[1])) found.push(`url credential ${m[0].slice(0, 12)}`);
  }
  for (const m of text.matchAll(/[\w.-]+@[\w.-]+\.[a-zA-Z]{2,}/g)) {
    if (!m[0].endsWith('@example.com')) found.push(`email ${m[0]}`);
  }
  for (const m of text.matchAll(/(?:sip:|")(\d{3,6})([a-z]{2,})(?:@|")/gi)) {
    // Device tags seen on the lab PBX; anything else may be a person's name and needs review.
    if (!['lab', 'ct', 'rn', 'calltester'].includes(m[2].toLowerCase())) found.push(`named sip user ${m[1]}…`);
  }
  if (/\.phoneware\.zone/i.test(text)) found.push('internal hostname');
  return found;
}

describe('live fixtures carry no real identifiers', () => {
  it('has fixtures to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s', (file) => {
    expect(leaks(readFileSync(resolve(DIR, file), 'utf8'))).toEqual([]);
  });

  it('catches each leak class it guards', () => {
    expect(leaks('"call-orig-caller-id": 6025527632')).toHaveLength(1);
    expect(leaks('"x": "sip:+16025527632@67.231.5.140"')).toHaveLength(2);
    expect(leaks('"file-access-url": "https://h/ns-api/?a=1&auth=b22becf0341e"')).toHaveLength(1);
    expect(leaks('"call-orig-from-user": "1001ctjdoe"')).toHaveLength(1);
    expect(leaks('"email": "someone@phoneware.us"')).toHaveLength(1);
    expect(leaks('"host": "core1-phx.phoneware.zone"')).toHaveLength(1);
    expect(leaks('"n": 6025550100, "ip": "192.0.2.1", "u": "1001lab", "e": "user@example.com"')).toEqual([]);
  });
});
