/**
 * Route module for fake NetSapiens: call detail records (CDR lists).
 *
 * Each row carries metadata, call-intelligence fields (AI summary and topics, classified as ai_summary), an internal
 * field (prefilled-transcription-api) and a field no classification names, so a projection test sees each removed.
 * GET /domains/{domain}/cdrs
 * GET /domains/{domain}/users/{user}/cdrs
 */

/** One CDR row, as the list endpoint returns it. */
export const CDR_FIXTURE_ROW = {
  'call-orig-call-id': 'cdr-1001',
  'call-orig-user': '1001',
  'call-term-user': '1002',
  'call-orig-domain': 'example.com',
  'call-direction': 'Outbound',
  'call-answer-datetime': '2026-11-20 10:00:00',
  'call-intelligence-summary': 'Customer asked about the March invoice.',
  'call-intelligence-topics-top': 'billing',
  'call-intelligence-percent-positive': '40',
  'prefilled-transcription-api': 'https://transcribe.example.com/session/abc',
  'x-debug-blob': 'not classified anywhere',
};

/**
 * @param {Record<string, any>} [state]
 * @returns {Array<{ method: string, path: string, handler: Function }>}
 */
export function cdrsRoute(state) {
  const rows = () => (Array.isArray(state?.cdrs) ? state.cdrs : [CDR_FIXTURE_ROW]);
  return [
    { method: 'GET', path: '/domains/{domain}/cdrs', handler: async () => ({ status: 200, body: rows() }) },
    { method: 'GET', path: '/domains/{domain}/users/{user}/cdrs', handler: async () => ({ status: 200, body: rows() }) },
  ];
}

export default cdrsRoute;
