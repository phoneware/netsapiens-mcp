/**
 * Route module for fake NetSapiens: redirects, for the registry's redirect tests. A probe path answers 302 or 307 with a
 * Location that names a voicemail read. A client that follows the redirect reaches that read, which answers with a media
 * link, so a followed redirect shows in the result as well as in the request log. The 401 probes answer 401 on their first
 * call and a redirect on the retry, which is the path a token refresh takes. Each 401 probe has its own counter.
 */

/** The voicemail read a redirect names. A client that follows the redirect sends a request to this path. */
export const REDIRECT_TARGET = '/ns-api/v2/domains/example.com/users/1001/voicemails/new/vm-1';

/**
 * @param {Record<string, any>} [state]
 * @returns {Array<{ method: string, path: string, handler: Function }>}
 */
export function redirectsRoute(state) {
  void state;
  let gateUnauthorized = 0;
  let unsetUnauthorized = 0;
  const redirect = (status) => ({ status, headers: { Location: REDIRECT_TARGET }, body: '' });
  return [
    { method: 'GET', path: '/domains/{domain}/users/{user}/redirect-probe', handler: async () => redirect(302) },
    { method: 'POST', path: '/domains/{domain}/redirect-probe', handler: async () => redirect(307) },
    {
      method: 'GET',
      path: '/domains/{domain}/redirect-probe-401-gate',
      handler: async () => {
        gateUnauthorized += 1;
        return gateUnauthorized === 1 ? { status: 401, body: { message: 'Token expired' } } : redirect(302);
      },
    },
    {
      method: 'GET',
      path: '/domains/{domain}/redirect-probe-401-unset',
      handler: async () => {
        unsetUnauthorized += 1;
        return unsetUnauthorized === 1 ? { status: 401, body: { message: 'Token expired' } } : redirect(302);
      },
    },
    {
      method: 'GET',
      path: '/domains/{domain}/users/{user}/voicemails/new/{message}',
      handler: async () => ({ status: 200, body: { 'file-access-url': 'https://media.example.com/vm-1.wav' } }),
    },
  ];
}

export default redirectsRoute;
