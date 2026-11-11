/**
 * Configuration and response types.
 *
 * The resource shapes below follow the field names in the NetSapiens v2
 * OpenAPI documents under spec/v2. Each lists the fields callers most often
 * read and keeps an index signature, because a host returns more than is
 * declared here and which extras it returns depends on its release.
 */

/** Credentials for the OAuth password grant against a NetSapiens host. */
export interface NetSapiensOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** NetSapiens login of the user the server acts as. */
  username: string;
  password: string;
}

/** How the client reaches one NetSapiens host. Set `apiToken` or `oauth`, not both. */
export interface NetSapiensConfig {
  /** Origin of the NetSapiens host, without the /ns-api path. */
  apiUrl: string;
  /** Static bearer token. */
  apiToken?: string;
  /** OAuth password-grant credentials, used instead of a static token. */
  oauth?: NetSapiensOAuthConfig;
  /** Per-request timeout in milliseconds. */
  timeout?: number;
  rateLimit?: {
    requests: number;
    perMilliseconds: number;
  };
  /** Called when the host answers 401, so the owner can install a fresh token. */
  onUnauthorized?: (err: unknown) => Promise<void> | void;
}

/** Everything the MCP server needs to start. */
export interface MCPServerConfig {
  name: string;
  version: string;
  netsapiens: NetSapiensConfig;
  debug?: boolean;
}

/** Uniform envelope the client returns instead of throwing. */
export interface NetSapiensApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/** GET /domains/{domain}/users/{user} */
export interface NetSapiensUser {
  domain: string;
  user: string;
  'name-first-name'?: string;
  'name-last-name'?: string;
  'login-username'?: string;
  email?: string;
  'user-scope'?: string;
  department?: string;
  site?: string;
  'time-zone'?: string;
  'dial-plan'?: string;
  'dial-policy'?: string;
  'voicemail-enabled'?: string;
  [field: string]: unknown;
}

/** GET /domains/{domain} */
export interface NetSapiensDomain {
  domain: string;
  reseller?: string;
  description?: string;
  'domain-type'?: string;
  'dial-plan'?: string;
  'dial-policy'?: string;
  'time-zone'?: string;
  'area-code'?: number;
  'caller-id-name'?: string;
  'caller-id-number'?: string;
  [field: string]: unknown;
}

/**
 * A call detail record. The call ids are the only fields this server reads
 * itself; the rest varies by host release.
 */
export interface NetSapiensCDR {
  id?: string;
  'call-orig-call-id'?: string;
  'call-term-call-id'?: string;
  'call-parent-call-id'?: string;
  'call-through-call-id'?: string;
  [field: string]: unknown;
}

/** GET /domains/{domain}/users/{user}/devices/{device} */
export interface NetSapiensDevice {
  device: string;
  user?: string;
  domain?: string;
  'device-sip-registration-uri'?: string;
  'device-sip-registration-state'?: string;
  'device-sip-registration-contact'?: string;
  'device-sip-registration-expires-datetime'?: string;
  'core-server'?: string;
  [field: string]: unknown;
}

/** GET /domains/{domain}/phonenumbers/{phonenumber} */
export interface NetSapiensPhoneNumber {
  phonenumber: string;
  domain?: string;
  enabled?: string;
  'dial-rule-application'?: string;
  'dial-rule-parameter'?: string;
  'dial-rule-translation-destination-user'?: string;
  'dial-rule-description'?: string;
  'sms-enabled'?: boolean;
  [field: string]: unknown;
}

/** GET /domains/{domain}/callqueues/{callqueue} */
export interface NetSapiensCallQueue {
  callqueue: string;
  domain: string;
  description?: string;
  'callqueue-dispatch-type'?: string;
  'callqueue-count-agents-available'?: number;
  'callqueue-count-agents-total'?: number;
  'active-queued-calls-total-current'?: number;
  [field: string]: unknown;
}

/** GET /domains/{domain}/callqueues/{callqueue}/agents */
export interface NetSapiensAgent {
  'callqueue-agent-id': string;
  callqueue?: string;
  domain?: string;
  'login-username'?: string;
  'name-full-name'?: string;
  'callqueue-agent-availability-type'?: string;
  'callqueue-agent-availability-for-dispatch'?: string;
  'active-calls-total-current'?: number;
  [field: string]: unknown;
}

/** GET /domains/{domain}/autoattendants */
export interface NetSapiensAutoAttendant {
  'attendant-name': string;
  user?: string;
  'starting-prompt'?: string;
  'read-path'?: string;
  timeframes?: unknown;
  [field: string]: unknown;
}

/** GET /domains/{domain}/users/{user}/answerrules/{timeframe} */
export interface NetSapiensAnswerRule {
  domain?: string;
  user?: string;
  'time-frame': string;
  enabled?: string;
  'is-active'?: boolean;
  'ordinal-priority'?: number;
  'forward-always'?: unknown;
  'forward-on-busy'?: unknown;
  'forward-no-answer'?: unknown;
  'do-not-disturb'?: unknown;
  [field: string]: unknown;
}

/** An audio file entry: a greeting, a hold message, or music on hold. */
export interface NetSapiensAudioFile {
  filename: string;
  'ordinal-order'?: number | string;
  'file-duration-seconds'?: number;
  'file-size-kilobytes'?: string;
  'created-datetime'?: string;
  'file-access-url'?: string;
  'file-source'?: string;
  [field: string]: unknown;
}

/** GET /domains/{domain}/users/{user}/greetings/{index} */
export type NetSapiensGreeting = NetSapiensAudioFile;

/** GET /domains/{domain}/moh/{index} */
export type NetSapiensMusicOnHold = NetSapiensAudioFile;

/** GET /domains/{domain}/users/{user}/voicemails/{folder} */
export interface NetSapiensVoicemail extends NetSapiensAudioFile {
  'voicemail-from-name'?: string;
  'voicemail-from-user'?: string;
  'voicemail-from-caller-id-number'?: string;
  'recorded-datetime'?: string;
  'file-transcript-text'?: string;
}

/** GET /domains/{domain}/billing */
export interface NetSapiensBilling {
  domain: string;
  description?: string;
  reseller?: string;
  'count-users-total'?: number;
  'count-call-queues'?: number;
  'count-phone-numbers'?: number;
  'count-devices-total'?: number;
  [field: string]: unknown;
}

// ==================== NEW TYPES ====================

export interface NetSapiensReseller {
  reseller: string;
  description?: string;
  status?: string;
  territory?: string;
}

export interface NetSapiensConference {
  object?: string;
  conference: string;
  domain: string;
  name?: string;
  description?: string;
  status?: string;
  max_participants?: number;
  pin?: string;
}

export interface NetSapiensConferenceParticipant {
  object?: string;
  participant: string;
  conference?: string;
  domain?: string;
  name?: string;
  status?: string;
}

export interface NetSapiensRoute {
  object?: string;
  route_id: string;
  description?: string;
  match_from?: string;
  match_to?: string;
  status?: string;
}

export interface NetSapiensRouteConnection {
  object?: string;
  index: number;
  route_id?: string;
  host?: string;
  port?: number;
  transport?: string;
}

export interface NetSapiensConnection {
  object?: string;
  connection_id?: string;
  domain?: string;
  orig_match_pattern?: string;
  host?: string;
  port?: number;
  status?: string;
}

export interface NetSapiensContact {
  object?: string;
  contact_id: string;
  domain?: string;
  user?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  company?: string;
}

export interface NetSapiensSite {
  object?: string;
  site: string;
  domain: string;
  description?: string;
  status?: string;
}

export interface NetSapiensTimeframe {
  object?: string;
  id: string;
  domain?: string;
  user?: string;
  name?: string;
  type?: string;
  status?: string;
}

export interface NetSapiensSubscription {
  object?: string;
  id: string;
  domain?: string;
  event?: string;
  url?: string;
  status?: string;
}

export interface NetSapiensDialPlan {
  object?: string;
  dialplan: string;
  domain?: string;
  description?: string;
  status?: string;
}

export interface NetSapiensDialRule {
  object?: string;
  dialrule: string;
  dialplan?: string;
  domain?: string;
  match?: string;
  replacement?: string;
  description?: string;
}

export interface NetSapiensDialPolicy {
  object?: string;
  policy: string;
  domain?: string;
  description?: string;
  status?: string;
}

export interface NetSapiensDialPermission {
  object?: string;
  id: string;
  policy?: string;
  domain?: string;
  match?: string;
  action?: string;
  description?: string;
}

export interface NetSapiensAddress {
  object?: string;
  emergency_address_id?: string;
  domain?: string;
  user?: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  status?: string;
}

export interface NetSapiensAddressEndpoint {
  object?: string;
  endpoint?: string;
  domain?: string;
  address_id?: string;
  status?: string;
}

export interface NetSapiensCertificate {
  object?: string;
  name: string;
  common_name?: string;
  issuer?: string;
  expires?: string;
  status?: string;
}

export interface NetSapiensImageFile {
  object?: string;
  filename: string;
  content_type?: string;
  size?: number;
}

export interface NetSapiensTemplate {
  object?: string;
  filename: string;
  content_type?: string;
  size?: number;
}

export interface NetSapiensPhoneConfig {
  object?: string;
  mac: string;
  domain?: string;
  model?: string;
  template?: string;
  status?: string;
}

export interface NetSapiensPhoneTemplate {
  object?: string;
  name: string;
  domain?: string;
  model?: string;
  description?: string;
}

export interface NetSapiensPhoneMac {
  object?: string;
  mac: string;
  domain?: string;
  model?: string;
  user?: string;
  status?: string;
}

export interface NetSapiensPhoneModel {
  object?: string;
  make?: string;
  model?: string;
  description?: string;
}

export interface NetSapiensDeviceProfile {
  object?: string;
  make?: string;
  model?: string;
  description?: string;
}

export interface NetSapiensHoldMessage {
  object?: string;
  index: number;
  domain?: string;
  user?: string;
  filename?: string;
  description?: string;
  duration?: number;
}

export interface NetSapiensNumberFilter {
  object?: string;
  domain?: string;
  user?: string;
  number?: string;
  direction?: string;
  status?: string;
}

export interface NetSapiensRecording {
  object?: string;
  call_id?: string;
  domain?: string;
  user?: string;
  filename?: string;
  duration?: number;
  timestamp?: string;
}

export interface NetSapiensTranscription {
  object?: string;
  call_id?: string;
  domain?: string;
  text?: string;
  language?: string;
  timestamp?: string;
}

export interface NetSapiensMessageSession {
  object?: string;
  messagesession?: string;
  domain?: string;
  user?: string;
  participants?: string[];
  name?: string;
  type?: string;
  status?: string;
}

export interface NetSapiensMessage {
  object?: string;
  message_id?: string;
  session_id?: string;
  from?: string;
  body?: string;
  timestamp?: string;
  type?: string;
}

export interface NetSapiensSmsNumber {
  object?: string;
  smsnumber: string;
  domain?: string;
  user?: string;
  status?: string;
}

export interface NetSapiensSmsBlock {
  object?: string;
  id?: string;
  domain?: string;
  number?: string;
  direction?: string;
  status?: string;
}

export interface NetSapiensVoicemailReminder {
  object?: string;
  user?: string;
  domain?: string;
  schedule?: string;
  method?: string;
  destination?: string;
  status?: string;
}

export interface NetSapiensApiKeyInfo {
  object?: string;
  key_id: string;
  description?: string;
  scope?: string;
  status?: string;
  created?: string;
  expires?: string;
}

export interface NetSapiensJwtInfo {
  object?: string;
  jti?: string;
  uid?: string;
  scope?: string;
  expires?: string;
}

export interface NetSapiensActiveCall {
  object?: string;
  call_id: string;
  domain?: string;
  user?: string;
  caller?: string;
  callee?: string;
  direction?: string;
  status?: string;
  start_time?: string;
}

export interface NetSapiensQueuedCall {
  object?: string;
  call_id?: string;
  callqueue?: string;
  domain?: string;
  caller?: string;
  wait_time?: number;
  status?: string;
}

export interface NetSapiensQuota {
  object?: string;
  domain?: string;
  reseller?: string;
  type?: string;
  limit?: number;
  used?: number;
}

export interface NetSapiensDashboard {
  object?: string;
  dashboard_id?: string;
  domain?: string;
  user?: string;
  name?: string;
  description?: string;
}

export interface NetSapiensChart {
  object?: string;
  chart_id?: string;
  dashboard_id?: string;
  type?: string;
  title?: string;
}

export interface NetSapiensSchedule {
  object?: string;
  schedule_name?: string;
  domain?: string;
  reseller?: string;
  type?: string;
  status?: string;
}

export interface NetSapiensHoliday {
  object?: string;
  country?: string;
  region?: string;
  name?: string;
  date?: string;
  type?: string;
}

export interface NetSapiensVideoCompany {
  object?: string;
  domain?: string;
  company_id?: string;
  name?: string;
  status?: string;
}

export interface NetSapiensVideoHost {
  object?: string;
  user?: string;
  domain?: string;
  host_id?: string;
  status?: string;
}

export interface NetSapiensVideoProduct {
  object?: string;
  product_id?: string;
  name?: string;
  description?: string;
  slug?: string;
}

export interface NetSapiensVideoSubscription {
  object?: string;
  subscription_id?: string;
  domain?: string;
  slug?: string;
  status?: string;
}

export interface NetSapiensMeeting {
  object?: string;
  id?: string;
  user?: string;
  domain?: string;
  title?: string;
  start_time?: string;
  end_time?: string;
  status?: string;
  pin?: string;
}

export interface NetSapiensMeetingLog {
  object?: string;
  event?: string;
  meeting_id?: string;
  instance?: string;
  timestamp?: string;
  details?: any;
}

export interface NetSapiensVoice {
  object?: string;
  voice_id?: string;
  name?: string;
  language?: string;
  gender?: string;
}

export interface NetSapiensFirebaseAccount {
  object?: string;
  project_id?: string;
  service_account?: string;
  status?: string;
}

export interface NetSapiensSipFlow {
  object?: string;
  call_id?: string;
  messages?: any[];
  cradle_to_grave?: any;
}

export interface NetSapiensDepartment {
  object?: string;
  department?: string;
  domain?: string;
  description?: string;
}

export interface NetSapiensPresence {
  object?: string;
  user?: string;
  domain?: string;
  status?: string;
  message?: string;
}

export interface NetSapiensConfigDefinition {
  object?: string;
  config_name: string;
  description?: string;
  type?: string;
  default_value?: string;
}

export interface NetSapiensConfiguration {
  object?: string;
  config_name: string;
  value?: string;
  scope?: string;
}

export interface NetSapiensInsight {
  object?: string;
  label?: string;
  data?: any;
}

export interface NetSapiensCallQueueReport {
  object?: string;
  callqueue?: string;
  domain?: string;
  calls?: any[];
}

export interface NetSapiensPhoneServer {
  object?: string;
  server?: string;
  description?: string;
  host?: string;
}
