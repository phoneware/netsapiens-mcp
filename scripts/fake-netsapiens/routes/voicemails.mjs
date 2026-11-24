/**
 * Route module for fake NetSapiens: voicemail messages. A voicemail read carries a playback link and a transcript,
 * both content.
 * GET /domains/{domain}/users/{user}/voicemails/{voicemail}
 */

/** One voicemail read. */
export const VOICEMAIL_FIXTURE = {
  'voicemail-id': 'vm-1',
  'file-access-url': 'https://media.example.com/vm-1.wav',
  'voicemail-transcription': 'Please call me back.',
};

/**
 * @returns {Array<{ method: string, path: string, handler: Function }>}
 */
export function voicemailsRoute() {
  return [
    {
      method: 'GET',
      path: '/domains/{domain}/users/{user}/voicemails/{voicemail}',
      handler: async () => ({ status: 200, body: VOICEMAIL_FIXTURE }),
    },
  ];
}

export default voicemailsRoute;
