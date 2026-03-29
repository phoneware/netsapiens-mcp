/**
 * Configuration types for NetSapiens MCP Server
 */

export interface NetSapiensOAuthConfig {
  /** OAuth Client ID */
  clientId: string;
  /** OAuth Client Secret */
  clientSecret: string;
  /** NetSapiens username */
  username: string;
  /** NetSapiens password */
  password: string;
}

export interface NetSapiensConfig {
  /** NetSapiens API server base URL */
  apiUrl: string;
  /** API authentication token (mutually exclusive with oauth) */
  apiToken?: string;
  /** OAuth configuration (mutually exclusive with apiToken) */
  oauth?: NetSapiensOAuthConfig;
  /** Optional timeout for API requests (milliseconds) */
  timeout?: number;
  /** Optional rate limiting configuration */
  rateLimit?: {
    requests: number;
    perMilliseconds: number;
  };
}

export interface MCPServerConfig {
  /** Server name */
  name: string;
  /** Server version */
  version: string;
  /** NetSapiens configuration */
  netsapiens: NetSapiensConfig;
  /** Debug mode */
  debug?: boolean;
}

export interface NetSapiensApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface NetSapiensUser {
  user: string;
  domain: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  status?: string;
  subscriber_id?: string;
  caller_id?: string;
  extension?: string;
  forward?: string;
  voicemail?: boolean;
  timezone?: string;
}

export interface NetSapiensDomain {
  domain: string;
  description?: string;
  customer?: string;
  status?: string;
  subscription?: string;
  territory?: string;
  timezone?: string;
}

export interface NetSapiensCDR {
  call_id?: string;
  caller?: string;
  callee?: string;
  start_time?: string;
  end_time?: string;
  duration?: number;
  disposition?: string;
  direction?: string;
  realm?: string;
  customer?: string;
}

export interface NetSapiensDevice {
  object: string;
  mac?: string;
  template?: string;
  user?: string;
  domain?: string;
  status?: string;
  model?: string;
}

export interface NetSapiensPhoneNumber {
  phonenumber: string;
  domain?: string;
  user?: string;
  object?: string;
  description?: string;
  status?: string;
  routing?: string;
}

export interface NetSapiensCallQueue {
  object: string;
  domain: string;
  name?: string;
  description?: string;
  status?: string;
  max_wait_time?: number;
  strategy?: string;
  music_on_hold?: string;
}

export interface NetSapiensAgent {
  object: string;
  agent?: string;
  domain?: string;
  user?: string;
  status?: string;
  skills?: string[];
  login_status?: string;
}

export interface NetSapiensAutoAttendant {
  object: string;
  domain: string;
  name?: string;
  prompt?: string;
  timeout?: number;
  options?: any;
}

export interface NetSapiensAnswerRule {
  object: string;
  timeframe: string;
  user?: string;
  domain?: string;
  forward?: string;
  voicemail?: boolean;
  status?: string;
}

export interface NetSapiensGreeting {
  object: string;
  index: number;
  user?: string;
  domain?: string;
  type?: string;
  filename?: string;
  duration?: number;
}

export interface NetSapiensVoicemail {
  object: string;
  user?: string;
  domain?: string;
  caller?: string;
  timestamp?: string;
  duration?: number;
  status?: string;
}

export interface NetSapiensMusicOnHold {
  object: string;
  index: number;
  domain?: string;
  filename?: string;
  description?: string;
  duration?: number;
}

export interface NetSapiensBilling {
  domain: string;
  period?: string;
  charges?: number;
  usage?: any;
  details?: any;
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
