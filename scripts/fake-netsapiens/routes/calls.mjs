/**
 * Route module for fake NetSapiens: active calls and call transfers.
 *
 * Tracks active calls per user with core-server, call-session-id, call_id.
 * GET  /ns-api/v2/domains/{domain}/users/{user}/calls/{callid}
 * PATCH /ns-api/v2/domains/{domain}/users/{user}/calls/{callid}/transfer
 */

/**
 * Normalizes call list from fake server state.
 *
 * @param {Record<string, any>} state
 * @returns {Array<Record<string, any>>}
 */
export function getCallsList(state) {
  if (!state) return [];
  if (!state.calls) {
    state.calls = [];
  }
  if (Array.isArray(state.calls)) {
    return state.calls;
  }
  if (state.calls instanceof Map) {
    return Array.from(state.calls.values());
  }
  if (typeof state.calls === 'object') {
    return Object.values(state.calls);
  }
  return [];
}

/**
 * Adds or updates a call record in fake server state.
 *
 * @param {Record<string, any>} state
 * @param {Record<string, any>} call
 * @returns {Record<string, any>}
 */
export function addCall(state, call) {
  if (!state) return call;
  if (!state.calls) state.calls = [];
  if (Array.isArray(state.calls)) {
    state.calls.push(call);
  } else if (state.calls instanceof Map) {
    state.calls.set(call.call_id || call.id || call['call-session-id'], call);
  } else if (typeof state.calls === 'object') {
    state.calls[call.call_id || call.id || call['call-session-id']] = call;
  }
  return call;
}

/**
 * Finds a call record by callid/session-id, domain, and user.
 *
 * @param {Record<string, any>} state
 * @param {string} [domain]
 * @param {string} [user]
 * @param {string} [callid]
 * @returns {Record<string, any> | undefined}
 */
export function findCall(state, domain, user, callid) {
  const calls = getCallsList(state);
  return calls.find((c) => {
    const idMatches =
      c.call_id === callid ||
      c.id === callid ||
      c['call-orig-call-id'] === callid ||
      c['call-term-call-id'] === callid ||
      c['call-through-call-id'] === callid ||
      c['call-session-id'] === callid;
    if (!idMatches) return false;

    if (domain && domain !== '~' && c.domain && c.domain !== '~' && c.domain !== domain) {
      return false;
    }
    if (user && user !== '~' && c.user && c.user !== '~' && c.user !== user) {
      return false;
    }
    return true;
  });
}

/**
 * Creates the calls route definitions for fake NetSapiens.
 *
 * @param {Record<string, any>} [state]
 * @returns {Array<{ method: string, path: string, handler: Function }>}
 */
export function callsRoute(state) {
  return [
    {
      method: 'GET',
      path: '/domains/{domain}/users/{user}/calls/{callid}',
      handler: async (req) => {
        const s = req.state || state || {};
        const domain = req.params?.domain;
        const user = req.params?.user;
        const callid = req.params?.callid ?? req.params?.call_id;

        const call = findCall(s, domain, user, callid);
        if (!call) {
          return {
            status: 404,
            body: { code: 404, message: 'Call not found' },
          };
        }

        return {
          status: 200,
          body: {
            'call-orig-call-id': call['call-orig-call-id'] || call.call_id || callid,
            'call-session-id': call['call-session-id'],
            'core-server': call['core-server'],
            'call-orig-user': call['call-orig-user'] || call.user || user,
            'call-orig-domain': call['call-orig-domain'] || call.domain || domain,
            'call-term-user': call['call-term-user'],
            duration: call.duration ?? 10,
            status: call.status ?? 'active',
            ...call,
          },
        };
      },
    },
    {
      method: 'PATCH',
      path: '/domains/{domain}/users/{user}/calls/{callid}/transfer',
      handler: async (req) => {
        const s = req.state || state || {};
        const domain = req.params?.domain;
        const user = req.params?.user;
        const callid = req.params?.callid ?? req.params?.call_id;

        const call = findCall(s, domain, user, callid);
        if (!call) {
          return {
            status: 404,
            body: { code: 404, message: 'Call not found' },
          };
        }

        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const termUser = body['call-term-user'];
        const hostname = body['hostname'];
        const destSessionId = body['call-destination-session-id'];

        if (termUser != null && String(termUser).trim().length > 0) {
          // Blind transfer
          call['call-term-user'] = String(termUser).trim();
          call.status = 'transferred';
          call.transferType = 'blind';

          if (!s.transfers) s.transfers = [];
          s.transfers.push({
            type: 'blind',
            callId: callid,
            to: String(termUser).trim(),
            call,
            timestamp: Date.now(),
          });

          return {
            status: 202,
            body: {
              code: 202,
              message: 'Accepted',
            },
          };
        }

        if (
          hostname != null && String(hostname).trim().length > 0 &&
          destSessionId != null && String(destSessionId).trim().length > 0
        ) {
          // Attended transfer
          const calls = getCallsList(s);
          const targetCall = calls.find((c) => c['call-session-id'] === String(destSessionId).trim());
          if (!targetCall) {
            return {
              status: 404,
              body: { code: 404, message: 'Destination call session not found' },
            };
          }

          call['merged-with-session-id'] = String(destSessionId).trim();
          call.status = 'merged';
          call.transferType = 'attended';
          targetCall['merged-with-session-id'] = call['call-session-id'];
          targetCall.status = 'merged';

          if (!s.merges) s.merges = [];
          s.merges.push({
            type: 'attended',
            sourceCallId: callid,
            targetSessionId: String(destSessionId).trim(),
            hostname: String(hostname).trim(),
            sourceCall: call,
            targetCall,
            timestamp: Date.now(),
          });

          return {
            status: 202,
            body: {
              code: 202,
              message: 'Accepted',
            },
          };
        }

        // Neither provided -> 400 with 46.0 documented error message
        return {
          status: 400,
          body: {
            code: 400,
            message: 'Neither `call-term-user` nor both `hostname` and `call-destination-session-id` were sent.',
          },
        };
      },
    },
  ];
}

export function createCallsRoute(initialCalls = []) {
  return (state) => {
    for (const call of initialCalls) {
      addCall(state, call);
    }
    return callsRoute(state);
  };
}

export const callsRouteModule = callsRoute;
export default callsRoute;
