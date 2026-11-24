/**
 * Route module for fake NetSapiens: the v1 RPC endpoint. A v1 call is POST /ns-api/ with a form body that names the
 * object and action. audio:play answers with a signed media link, which the recording kind classifies as content.
 * The fake logs the request before routing, so a call the connector refuses is visible as a request that never came.
 */

/**
 * @returns {Array<{ method: string, path: string, handler: Function }>}
 */
export function v1Route() {
  return [
    {
      method: 'POST',
      path: '/ns-api/',
      handler: async (req) => {
        const form = new URLSearchParams(typeof req.body === 'string' ? req.body : '');
        const object = form.get('object');
        const action = form.get('action');
        if (object === 'audio' && action === 'play') {
          return { status: 200, body: { 'file-access-url': 'https://media.example.com/greeting.wav' } };
        }
        return { status: 200, body: { object, action, ok: true } };
      },
    },
  ];
}

export default v1Route;
