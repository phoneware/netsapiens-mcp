/**
 * Route module for fake NetSapiens: call detail records (CDR lists).
 *
 * Each row carries metadata, call-intelligence fields (the AI summary, the topics and the sentiment group, all classified
 * as ai_summary), an internal field (prefilled-transcription-api) and a field no classification names, so a projection
 * test sees each removed.
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
  'call-intelligence-percent-negative': '20',
  'call-intelligence-percent-neutral': '40',
  'call-intelligence-ending-percent-negative': '10',
  'call-intelligence-ending-percent-neutral': '50',
  'call-intelligence-ending-percent-positive': '40',
  'call-intelligence-duration-seconds-negative': '12',
  'call-intelligence-duration-seconds-neutral': '30',
  'call-intelligence-duration-seconds-positive': '45',
  'call-intelligence-ending-duration-seconds-negative': '4',
  'call-intelligence-ending-duration-seconds-neutral': '9',
  'call-intelligence-ending-duration-seconds-positive': '6',
  'call-intelligence-ending-sentiment-scale': '3',
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
