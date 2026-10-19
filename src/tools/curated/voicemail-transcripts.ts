import type { GenericApiClient } from '../../generated/types.js';
import type { UserRole } from '../../auth/roles.js';
import { matchesCallId, toNsDateTime } from './catalog.js';

export async function attachVoicemailTranscripts<
  T extends Record<string, unknown> | Array<Record<string, unknown>>
>(
  client: GenericApiClient,
  records: T,
  userRole?: UserRole,
): Promise<T> {
  if (!records) return records;
  const isArray = Array.isArray(records);
  const items: Array<Record<string, unknown>> = isArray
    ? (records as Array<Record<string, unknown>>)
    : [records as Record<string, unknown>];

  if (items.length === 0) {
    return records;
  }

  const BATCH_SIZE = 5;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (record) => {
        try {
          await attachOneVoicemailTranscript(client, record, userRole);
        } catch {
          record['transcription-status'] = 'unavailable';
        }
      })
    );
  }

  return records;
}

async function attachOneVoicemailTranscript(
  client: GenericApiClient,
  record: Record<string, unknown>,
  userRole?: UserRole,
): Promise<void> {
  const filename = typeof record['filename'] === 'string'
    ? record['filename']
    : typeof record['id'] === 'string'
      ? record['id']
      : '';

  // 2. If the record already has a non-empty transcription, mark it finished and skip the rest.
  if (typeof record['transcription'] === 'string' && record['transcription'].trim() !== '') {
    record['transcription-status'] = 'finished';
    return;
  }

  // 1. The filename must match /^vm-(.+)\.wav$/i, which gives termCallId; otherwise unavailable.
  const match = /^vm-(.+)\.wav$/i.exec(filename);
  if (!match) {
    record['transcription-status'] = 'unavailable';
    return;
  }
  const termCallId = match[1];

  // 3. Read YYYYMMDDHHMMSS (UTC) from the first 14 characters of termCallId.
  if (termCallId.length < 14) {
    record['transcription-status'] = 'unavailable';
    return;
  }

  const y = Number(termCallId.slice(0, 4));
  const mo = Number(termCallId.slice(4, 6));
  const d = Number(termCallId.slice(6, 8));
  const h = Number(termCallId.slice(8, 10));
  const mi = Number(termCallId.slice(10, 12));
  const s = Number(termCallId.slice(12, 14));

  const ts = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (isNaN(ts.getTime())) {
    record['transcription-status'] = 'unavailable';
    return;
  }

  const start = new Date(ts.getTime() - 2 * 60 * 1000);
  const end = new Date(ts.getTime() + 10 * 60 * 1000);

  const cdrRes = await client.request<Array<Record<string, unknown>>>({
    method: 'GET',
    pathTemplate: '/domains/~/users/~/cdrs',
    queryParams: {
      'datetime-start': toNsDateTime(start),
      'datetime-end': toNsDateTime(end),
      limit: 50,
    },
  });

  if (!cdrRes?.success || !Array.isArray(cdrRes.data)) {
    record['transcription-status'] = 'unavailable';
    return;
  }

  const cdrRow = cdrRes.data.find((row) => matchesCallId(row, termCallId));
  if (!cdrRow) {
    record['transcription-status'] = 'unavailable';
    return;
  }

  // 4. Parse prefilled-transcription-api with new URL(v, 'https://ns.invalid').
  const v = cdrRow['prefilled-transcription-api'];
  if (typeof v !== 'string' || !v) {
    record['transcription-status'] = 'unavailable';
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(v, 'https://ns.invalid');
  } catch {
    record['transcription-status'] = 'unavailable';
    return;
  }

  const pathMatch = /^\/ns-api\/v2\/domains\/([^/]+)\/transcriptions$/.exec(parsedUrl.pathname);
  if (!pathMatch) {
    record['transcription-status'] = 'unavailable';
    return;
  }
  const domain = decodeURIComponent(pathMatch[1]);

  const queryParams: Record<string, unknown> = {};
  for (const [key, val] of parsedUrl.searchParams.entries()) {
    queryParams[key] = val;
  }

  if (userRole === 'user' && !queryParams.user && cdrRow['call-term-user']) {
    queryParams.user = String(cdrRow['call-term-user']);
  }

  const transRes = await client.request<Record<string, unknown> | Array<Record<string, unknown>>>({
    method: 'GET',
    pathTemplate: '/domains/{domain}/transcriptions',
    pathParams: { domain },
    queryParams,
  });

  if (!transRes?.success || !transRes.data) {
    record['transcription-status'] = 'unavailable';
    return;
  }

  const transObj = (Array.isArray(transRes.data) ? transRes.data[0] : transRes.data) as Record<string, unknown>;
  if (!transObj || typeof transObj !== 'object') {
    record['transcription-status'] = 'unavailable';
    return;
  }

  // 5. If call-intelligence-processing-status is not finished, mark the record processing.
  const procStatus = transObj['call-intelligence-processing-status'];
  if (procStatus !== 'finished') {
    record['transcription-status'] = 'processing';
    return;
  }

  // 6. Otherwise, transcription is the comment (or text) of each segment whose speaker is not
  // ${row['call-term-user']}@${domain}, joined with spaces. If that is empty, use all segments.
  // If the text is still empty, mark the record unavailable.
  const segmentsRaw = transObj['call-intelligence-segments'] ?? transObj['segments'];
  const segments = Array.isArray(segmentsRaw) ? (segmentsRaw as Array<Record<string, unknown>>) : [];

  const termUser = cdrRow['call-term-user'];
  const calleeSpeaker = `${termUser}@${domain}`;

  const callerSegments = segments.filter((seg) => {
    const spk = typeof seg['speaker'] === 'string' ? seg['speaker'] : '';
    return spk !== calleeSpeaker && spk !== `sip:${calleeSpeaker}`;
  });

  let texts = callerSegments
    .map((seg) => (typeof (seg['comment'] ?? seg['text']) === 'string' ? String(seg['comment'] ?? seg['text']).trim() : ''))
    .filter(Boolean);
  if (texts.length === 0) {
    texts = segments
      .map((seg) => (typeof (seg['comment'] ?? seg['text']) === 'string' ? String(seg['comment'] ?? seg['text']).trim() : ''))
      .filter(Boolean);
  }

  const transcript = texts.join(' ').trim();
  if (!transcript) {
    record['transcription-status'] = 'unavailable';
    return;
  }

  record['transcription'] = transcript;
  record['transcription-status'] = 'finished';
}
