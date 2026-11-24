/**
 * Route module for fake NetSapiens: transcriptions. The list returns transcript text, which the transcript kind
 * classifies as content.
 * GET /domains/{domain}/transcriptions
 */

/** One transcript row. */
export const TRANSCRIPTION_FIXTURE_ROW = {
  'call-orig-call-id': 'cdr-1001',
  'transcription-text': 'Thanks for calling, how can I help?',
};

/**
 * @returns {Array<{ method: string, path: string, handler: Function }>}
 */
export function transcriptionsRoute() {
  return [
    {
      method: 'GET',
      path: '/domains/{domain}/transcriptions',
      handler: async () => ({ status: 200, body: [TRANSCRIPTION_FIXTURE_ROW] }),
    },
  ];
}

export default transcriptionsRoute;
