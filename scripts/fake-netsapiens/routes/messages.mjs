/**
 * Route module for fake NetSapiens: message bodies. A message session's messages are text the sms_text kind classifies
 * as content; a send is a write.
 * GET  /domains/{domain}/users/{user}/messagesessions/{session}/messages
 * POST /domains/{domain}/users/{user}/messages
 */

/** One message body. */
export const MESSAGE_FIXTURE_ROW = {
  'message-id': 'msg-1',
  'message-text': 'Your appointment is at noon.',
};

/**
 * @returns {Array<{ method: string, path: string, handler: Function }>}
 */
export function messagesRoute() {
  return [
    {
      method: 'GET',
      path: '/domains/{domain}/users/{user}/messagesessions/{session}/messages',
      handler: async () => ({ status: 200, body: [MESSAGE_FIXTURE_ROW] }),
    },
    {
      method: 'POST',
      path: '/domains/{domain}/users/{user}/messages',
      handler: async (req) => ({ status: 201, body: { 'message-id': 'msg-2', received: req.body } }),
    },
  ];
}

export default messagesRoute;
