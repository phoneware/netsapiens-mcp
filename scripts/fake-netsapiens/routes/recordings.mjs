/**
 * Route module for fake NetSapiens: call recordings. The fake logs every request it receives, so a recording read is
 * visible in fake.requests whether or not the connector answered it.
 * GET /domains/{domain}/recordings/{recording}
 * GET /domains/{domain}/users/{user}/recordings/{recording}
 */

/** One recording read: the signed playback link is the content a recording kind classifies. */
export const RECORDING_FIXTURE = {
  'call-recording-id': 'rec-1001',
  'call-recording-remote-wav': 'https://media.example.com/rec-1001.wav',
};

/**
 * @returns {Array<{ method: string, path: string, handler: Function }>}
 */
export function recordingsRoute() {
  const read = async () => ({ status: 200, body: RECORDING_FIXTURE });
  return [
    { method: 'GET', path: '/domains/{domain}/recordings/{recording}', handler: read },
    { method: 'GET', path: '/domains/{domain}/users/{user}/recordings/{recording}', handler: read },
  ];
}

export default recordingsRoute;
