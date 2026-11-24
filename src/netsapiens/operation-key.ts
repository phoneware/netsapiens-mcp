export type OperationMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export function normalizeOperationKey(method: string, path: string): string {
  const upper = method.toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(upper)) {
    throw new Error(`Unsupported operation method: ${method}`);
  }
  let normalized = path.replace(/#\d+$/, '');
  if (normalized !== '/') normalized = normalized.replace(/\/$/, '');
  normalized = normalized.split('/').map(segment => segment === '~' || /^\{[^}]*\}$/.test(segment) ? '{}' : segment).join('/');
  return `${upper} ${normalized}`;
}

/** One reviewed v1 operation: what it does, and the v2 operations of the same effect, by registry key. */
export interface V1Review {
  /** One line: what the operation does and why it is or is not destructive. */
  readonly reason: string;
  /** The v2 operations this one pairs with. Absent when no v2 form matches. */
  readonly v2?: readonly string[];
}

const AUDIO_FILE_DELETES = [
  'DELETE /domains/{}/users/{}/greetings/{}',
  'DELETE /domains/{}/users/{}/moh/{}',
  'DELETE /domains/{}/users/{}/msg/{}',
  'DELETE /domains/{}/moh/{}',
  'DELETE /domains/{}/msg/{}',
];

/**
 * The destructive v1 operations, one reviewed entry each, keyed v1:<object>:<action>. A v1 operation is destructive when
 * its v2 form is a DELETE, or when it ends or removes what a v2 DELETE removes. An operation that only changes state is
 * not destructive unless its v2 form is a DELETE. Every v2 key named here is a DELETE in the registry (the test checks).
 */
export const V1_DESTRUCTIVE_ACTIONS: Readonly<Record<string, V1Review>> = {
  'v1:address:delete': { reason: 'deletes an emergency address in a domain', v2: ['DELETE /domains/{}/addresses/{}'] },
  'v1:address:deleteAddressEndpoint': { reason: 'deletes an address endpoint', v2: ['DELETE /domains/{}/addresses/endpoints/{}'] },
  'v1:agent:delete': { reason: 'removes an agent from a call queue', v2: ['DELETE /domains/{}/callqueues/{}/agents/{}'] },
  'v1:answerrule:delete': { reason: 'deletes an answer rule of a user', v2: ['DELETE /domains/{}/users/{}/answerrules/{}'] },
  'v1:audio:delete': { reason: 'deletes an audio file (greeting, music on hold or hold message) at an index', v2: AUDIO_FILE_DELETES },
  'v1:audio:link_delete': { reason: 'deletes an audio file through a link authorisation', v2: AUDIO_FILE_DELETES },
  'v1:call:disconnect': { reason: 'ends a call in progress: every leg of the call is hung up', v2: ['DELETE /domains/{}/users/{}/calls/{}'] },
  'v1:call:reject': { reason: 'turns away a call that is still ringing, before it is answered', v2: ['DELETE /domains/{}/users/{}/calls/{}/reject'] },
  'v1:callqueue:delete': { reason: 'deletes a call queue', v2: ['DELETE /domains/{}/callqueues/{}'] },
  'v1:callqueueemailreport:delete': { reason: 'deletes an emailed report request and its schedule', v2: ['DELETE /domains/{}/callcenter-reports/{}'] },
  'v1:callrequest:delWakeUp': { reason: 'deletes wake-up call requests of a subscriber; no v2 form' },
  'v1:cdr2:optimize': { reason: 'UNVERIFIED: optimises CDRs older than a date, which may remove rows; the apidoc gives no parameters or description, so it stays destructive until NetSapiens documents that it deletes nothing' },
  'v1:cdr2:purge': { reason: 'purges CDRs older than a date, which deletes them; no v2 form' },
  'v1:cdrexport:delete': { reason: 'deletes a CDR export file; the v2 schedule delete keeps delivered files, so no v2 form matches' },
  'v1:cdrschedule:delete': { reason: 'deletes a CDR export schedule and its export history', v2: ['DELETE /domains/{}/schedule/{}', 'DELETE /schedule/{}'] },
  'v1:chart:delete': { reason: 'deletes a chart of a dashboard', v2: ['DELETE /domains/{}/charts/{}'] },
  'v1:conference:delete': { reason: 'deletes a conference bridge', v2: ['DELETE /domains/{}/conferences/{}'] },
  'v1:connection:delete': { reason: 'deletes a connection', v2: ['DELETE /domains/{}/connections/{}', 'DELETE /connections/{}'] },
  'v1:contact:delete': { reason: 'deletes a contact and its avatar', v2: ['DELETE /domains/{}/contacts/{}', 'DELETE /domains/{}/users/{}/contacts/{}'] },
  'v1:dashboard:delete': { reason: 'deletes a dashboard and every chart on it', v2: ['DELETE /domains/{}/users/{}/dashboards'] },
  'v1:device:delete': { reason: 'deletes a device and its call recording configuration', v2: ['DELETE /domains/{}/users/{}/devices/{}'] },
  'v1:dialrule:delete': { reason: 'deletes a dial rule', v2: ['DELETE /domains/{}/dialplans/{}/dialrules/{}', 'DELETE /dialplans/{}/dialrules/{}'] },
  'v1:domain:delete': { reason: 'deletes a domain and everything in it', v2: ['DELETE /domains/{}'] },
  'v1:event:delete': { reason: 'deletes an event subscription', v2: ['DELETE /subscriptions/{}', 'DELETE /domains/{}/subscriptions/{}'] },
  'v1:mac:delete': { reason: 'deletes the phone with a MAC address; the v2 form removes it from inventory', v2: ['DELETE /domains/{}/phones'] },
  'v1:meeting:delete': { reason: 'cancels and removes a meeting', v2: ['DELETE /domains/{}/users/{}/meetings/{}'] },
  'v1:meeting:deleteEvents': { reason: 'deletes the events of a meeting instance; no v2 form' },
  'v1:message:delete': { reason: 'removes one message from a conversation for the user; no single-message v2 form' },
  'v1:messagesession:delete': { reason: 'removes a conversation from the record of one user', v2: ['DELETE /domains/{}/users/{}/messagesessions/{}'] },
  'v1:messagesession:dispatch': { reason: 'ends an agent handling of a conversation, which leaves the agent session list: the effect of the v2 session delete (conservative, the apidoc names no effect)', v2: ['DELETE /domains/{}/users/{}/messagesessions/{}'] },
  'v1:messagesession:leave': { reason: 'removes this user from a conversation, which leaves the user session list: the effect of the v2 session delete (conservative, the apidoc gives no description)', v2: ['DELETE /domains/{}/users/{}/messagesessions/{}'] },
  'v1:permission:delete': { reason: 'deletes a rule of a dial policy', v2: ['DELETE /domains/{}/dialpolicy/{}/permission/{}', 'DELETE /dialpolicy/{}/permission/{}'] },
  'v1:phoneconfiguration:delete': { reason: 'deletes the button layout of a phone', v2: ['DELETE /domains/{}/phoneconfiguration/{}'] },
  'v1:phonenumber:delete': { reason: 'removes a phone number from the domain', v2: ['DELETE /domains/{}/phonenumbers/{}'] },
  'v1:quota:delete': { reason: 'removes the recording quota of a domain', v2: ['DELETE /domains/{}/quotas', 'DELETE /quotas/{}', 'DELETE /resellers/{}/quotas/{}'] },
  'v1:recording:delete': { reason: 'turns call recording off for an address of record by removing its entries', v2: ['DELETE /recordings/entries'] },
  'v1:reseller:delete': { reason: 'deletes a territory (reseller)', v2: ['DELETE /resellers/{}'] },
  'v1:route:delete': { reason: 'deletes a route', v2: ['DELETE /routes/{}', 'DELETE /routes', 'DELETE /routes/frm/{}'] },
  'v1:routecon:delete': { reason: 'deletes a route connection', v2: ['DELETE /routes/{}/routecon/{}', 'DELETE /routecon'] },
  'v1:subscriber:delete': { reason: 'deletes a user and everything that belongs to it', v2: ['DELETE /domains/{}/users/{}'] },
  'v1:uiconfig:delete': { reason: 'deletes one configuration row', v2: ['DELETE /configurations/{}'] },
  'v1:uiconfigdef:delete': { reason: 'deletes a configuration definition and every row with its name', v2: ['DELETE /config-definitions/{}'] },
  'v1:vmailnag:delete': { reason: 'removes the voicemail reminder of a user', v2: ['DELETE /domains/{}/users/{}/vmailnag'] },
};

/**
 * The non-destructive v1 operations, one reviewed entry each, keyed v1:<object>:<action>. Read operations are not listed:
 * V1_READ_ACTION classifies them, and the review test checks that no read name carries a destructive word.
 */
export const V1_NOT_DESTRUCTIVE: Readonly<Record<string, V1Review>> = {
  'v1:address:applyEndpoints': { reason: 'updates the endpoints of a user from an address; the apidoc names no removal and no v2 DELETE applies' },
  'v1:address:copyEndpoint': { reason: 'copies an endpoint into another domain; the original stays' },
  'v1:address:create': { reason: 'creates an emergency address' },
  'v1:address:createAddressEndpoint': { reason: 'creates an address endpoint' },
  'v1:address:duplicate': { reason: 'copies an address; the original stays' },
  'v1:address:update': { reason: 'changes an address in place' },
  'v1:address:validate': { reason: 'checks an address and changes nothing' },
  'v1:agent:create': { reason: 'adds an agent to a call queue' },
  'v1:agent:update': { reason: 'changes an agent of a call queue, or its status' },
  'v1:agentlog:create': { reason: 'writes an agent log entry' },
  'v1:answerrule:create': { reason: 'creates an answer rule' },
  'v1:answerrule:reorder': { reason: 'changes the order of answer rules and removes none' },
  'v1:audio:link_update': { reason: 'changes an audio file through a link authorisation' },
  'v1:audio:play': { reason: 'plays or downloads an audio file and changes nothing' },
  'v1:audio:update': { reason: 'changes an audio file' },
  'v1:audio:upload': { reason: 'uploads an audio file' },
  'v1:call:answer': { reason: 'answers a ringing call; the call continues' },
  'v1:call:call': { reason: 'places a new call' },
  'v1:call:call_to_playback': { reason: 'plays a recorded message into a call; the call continues' },
  'v1:call:call_to_record': { reason: 'records a message into a call; the call continues' },
  'v1:call:hold_orig': { reason: 'holds the source leg of a call; the call continues' },
  'v1:call:hold_term': { reason: 'holds the recipient leg of a call; the call continues' },
  'v1:call:park': { reason: 'parks a call in a free park slot; the call continues' },
  'v1:call:record_off': { reason: 'stops recording a call; a state change with no v2 DELETE' },
  'v1:call:record_on': { reason: 'starts recording a call' },
  'v1:call:record_pause': { reason: 'pauses a call recording' },
  'v1:call:record_unpause': { reason: 'resumes a call recording' },
  'v1:call:report': { reason: 'reports the active calls and changes nothing' },
  'v1:call:unhold': { reason: 'resumes a held call; the call continues' },
  'v1:call:xfer': { reason: 'transfers an active call; the call continues' },
  'v1:call:xfer_peer': { reason: 'transfers the peer leg of a call; the call continues' },
  'v1:callqueue:create': { reason: 'creates a call queue' },
  'v1:callqueue:update': { reason: 'changes a call queue' },
  'v1:callqueueemailreport:create': { reason: 'creates an emailed report request' },
  'v1:callqueueemailreport:update': { reason: 'changes an emailed report request' },
  'v1:callrequest:addWakeUp': { reason: 'adds wake-up call requests for a subscriber' },
  'v1:cdr2:report': { reason: 'reports CDRs by domain and changes nothing' },
  'v1:cdr2:update': { reason: 'changes a CDR' },
  'v1:cdrexport:create': { reason: 'creates a CDR export' },
  'v1:cdrexport:download': { reason: 'downloads a CDR export file and changes nothing' },
  'v1:cdrexport:update': { reason: 'changes a CDR export' },
  'v1:cdrschedule:create': { reason: 'creates a CDR export schedule' },
  'v1:cdrschedule:update': { reason: 'changes a CDR export schedule' },
  'v1:chart:create': { reason: 'creates a chart on a dashboard' },
  'v1:chart:update': { reason: 'changes a chart' },
  'v1:conference:create': { reason: 'creates a conference bridge' },
  'v1:conference:update': { reason: 'changes a conference bridge' },
  'v1:connection:create': { reason: 'creates a connection' },
  'v1:connection:update': { reason: 'changes a connection' },
  'v1:contact:create': { reason: 'creates a contact' },
  'v1:contact:update': { reason: 'changes a contact' },
  'v1:dashboard:create': { reason: 'creates a dashboard' },
  'v1:dashboard:favorite': { reason: 'toggles a dashboard as a favourite' },
  'v1:dashboard:hide': { reason: 'toggles the visibility of a dashboard' },
  'v1:dashboard:update': { reason: 'changes a dashboard' },
  'v1:device:create': { reason: 'creates a device' },
  'v1:device:update': { reason: 'changes a device' },
  'v1:deviceprofile:create': { reason: 'creates a device profile' },
  'v1:dialplan:create': { reason: 'creates a dial plan' },
  'v1:dialrule:create': { reason: 'creates a dial rule' },
  'v1:dialrule:update': { reason: 'changes a dial rule' },
  'v1:domain:create': { reason: 'creates a domain' },
  'v1:domain:update': { reason: 'changes a domain' },
  'v1:email:create': { reason: 'emails a call center report and removes nothing' },
  'v1:event:create': { reason: 'creates an event subscription' },
  'v1:mac:create': { reason: 'creates a MAC entry' },
  'v1:mac:update': { reason: 'changes the device with a MAC address' },
  'v1:meeting:create': { reason: 'creates a meeting' },
  'v1:meeting:logEvent': { reason: 'logs a meeting event and removes none' },
  'v1:meeting:update': { reason: 'changes a meeting' },
  'v1:message:create': { reason: 'sends a new message' },
  'v1:messagesession:accept': { reason: 'accepts a conversation for an agent' },
  'v1:messagesession:update': { reason: 'changes a conversation' },
  'v1:participant:create': { reason: 'adds participants to a conference' },
  'v1:permission:create': { reason: 'creates a rule of a dial policy' },
  'v1:permission:update': { reason: 'changes a rule of a dial policy' },
  'v1:phoneconfiguration:create': { reason: 'creates a phone configuration' },
  'v1:phonenumber:create': { reason: 'adds a phone number to inventory' },
  'v1:phonenumber:update': { reason: 'changes a phone number' },
  'v1:queued:update': { reason: 'changes the priority of a queued call' },
  'v1:queuedcall:create': { reason: 'queues a call' },
  'v1:quota:create': { reason: 'creates a recording quota for a domain' },
  'v1:quota:update': { reason: 'changes a recording quota' },
  'v1:recording:create': { reason: 'turns call recording on for an address of record' },
  'v1:recording:update': { reason: 'changes recording configuration' },
  'v1:reseller:create': { reason: 'creates a territory (reseller)' },
  'v1:reseller:update': { reason: 'changes a territory (reseller)' },
  'v1:route:create': { reason: 'creates a route' },
  'v1:route:update': { reason: 'changes a route' },
  'v1:routecon:create': { reason: 'creates a route connection' },
  'v1:routecon:update': { reason: 'changes a route connection' },
  'v1:smsnumber:create': { reason: 'creates an SMS number' },
  'v1:smsnumber:update': { reason: 'changes an SMS number' },
  'v1:subscriber:create': { reason: 'creates a user or a department' },
  'v1:subscriber:update': { reason: 'changes a user' },
  'v1:timeframe:create': { reason: 'creates a time frame' },
  'v1:timeframe:update': { reason: 'changes a time frame' },
  'v1:timerange:create': { reason: 'creates a time range' },
  'v1:timerange:update': { reason: 'changes a time range' },
  'v1:trace:export': { reason: 'exports a call trace and changes nothing on the server' },
  'v1:uiconfig:create': { reason: 'creates a UI configuration' },
  'v1:uiconfig:update': { reason: 'changes a UI configuration' },
  'v1:uiconfigdef:create': { reason: 'creates a UI configuration definition' },
  'v1:upload:create': { reason: 'starts an upload and returns a temporary file id' },
  'v1:upload:upload': { reason: 'uploads a chunk of a file' },
  'v1:vmailnag:create': { reason: 'creates a voicemail reminder' },
  'v1:vmailnag:update': { reason: 'changes a voicemail reminder' },
};

/**
 * Words that say an operation ends, removes or disconnects something. The review test reads them: an operation whose name
 * carries one, and that has no reviewed entry, fails. The runtime check below does not read them, so a name that only
 * carries one of them is decided by its reviewed entry.
 */
export const V1_DESTRUCTIVE_LOOKING_WORDS: ReadonlySet<string> = new Set([
  'disconnect', 'reject', 'hangup', 'end', 'stop', 'close', 'unlink', 'unsubscribe', 'unregister', 'deregister', 'unassign',
  'detach', 'evict', 'kill', 'drop', 'wipe', 'erase', 'forget', 'release', 'expire', 'leave',
]);

/** Verbs that remove or end something. A word that begins with one is destructive: deleteEvents, purgecdrs, resetCache. */
const DESTRUCTIVE_STEMS = ['delete', 'remove', 'destroy', 'cancel', 'revoke', 'reset', 'restart', 'reboot', 'restore', 'purge', 'clear', 'terminate'];

/** English words that begin with del and are not deletes. Any other word that begins with del is the delete abbreviation. */
const DEL_NOT_DELETE_STEMS = ['deliver', 'delay', 'delegat', 'delimit', 'delta'];

/** The lowercase words of a v1 action name. Underscores, hyphens and camelCase boundaries separate words: bulkDelete is bulk and delete. */
export function v1ActionWords(action: string): string[] {
  return action
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(word => word !== '')
    .map(word => word.toLowerCase());
}

function isDestructiveWord(word: string): boolean {
  if (DESTRUCTIVE_STEMS.some(stem => word.startsWith(stem))) return true;
  return word.startsWith('del') && !DEL_NOT_DELETE_STEMS.some(stem => word.startsWith(stem));
}

/**
 * Whether an action name carries a destructive verb. A word that begins with a destructive verb matches, so both
 * deleteEvents and bulkDelete do, and so does the lowercase compound delwakeup, which the del abbreviation begins.
 * deliver, delay and deliveryStatus do not match. A lowercase compound has no boundary to split at (bulkdelete), so
 * delete and remove also match anywhere in it. disconnect and reject carry no verb: their reviewed entries decide them.
 */
export function isDestructiveV1Verb(action: string): boolean {
  if (v1ActionWords(action).some(isDestructiveWord)) return true;
  const lower = action.toLowerCase();
  return lower.includes('delete') || lower.includes('remove');
}

/** Whether a v1 operation is destructive, whatever its object: its reviewed entry says so, or its action carries a destructive verb. */
export function isDestructiveV1Action(object: string, action: string): boolean {
  return Object.hasOwn(V1_DESTRUCTIVE_ACTIONS, `v1:${object}:${action}`) || isDestructiveV1Verb(action);
}

/** The v1 actions the access policy reads as read-only. Mirrors READ_ACTION in src/access/policy.ts. */
export const V1_READ_ACTION = /^(read|count|list|search|get)/;
