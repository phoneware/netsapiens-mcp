import type { FieldClass } from './types.js';

/**
 * Hand-reviewed field classification overrides for NetSapiens schemas.
 *
 * Every schema property in `spec/netsapiens-api-v2.json` defaults to `{ class: 'metadata' }`.
 * Entries here override that default to designate content-bearing (text/audio/transcription),
 * secret (credentials, passwords, pins, private tokens), internal plumbing, or record_id fields.
 */
export const FIELD_OVERRIDES: Record<string, Record<string, FieldClass>> = {
 // CDRs and Call Intelligence
 CdrD: {
  id: { class: 'record_id', recordType: 'cdr' },
  'call-orig-call-id': { class: 'record_id', recordType: 'call' },
  'call-term-call-id': { class: 'record_id', recordType: 'call' },
  'call-parent-call-id': { class: 'record_id', recordType: 'call' },
  'call-through-call-id': { class: 'record_id', recordType: 'call' },
  'call-intelligence-topics-top': { class: 'content', kind: 'ai_summary', media: 'text' },
  ending_sentiment: { class: 'content', kind: 'ai_summary', media: 'text' },
  'prefilled-transcription-api': { class: 'internal' },
  'prefilled-trace-api': { class: 'internal' },
  'call-audio-relay-side-a-remote-ip': { class: 'internal' },
  'call-audio-relay-side-b-remote-ip': { class: 'internal' },
  'call-audio-relay-side-a-local-port': { class: 'internal' },
  'call-audio-relay-side-b-local-port': { class: 'internal' },
  'call-fax-relay-side-a-remote-ip': { class: 'internal' },
  'call-fax-relay-side-b-remote-ip': { class: 'internal' },
  'call-fax-relay-side-a-local-port': { class: 'internal' },
  'call-fax-relay-side-b-local-port': { class: 'internal' },
  'call-video-relay-side-a-remote-ip': { class: 'internal' },
  'call-video-relay-side-b-remote-ip': { class: 'internal' },
  'call-video-relay-side-a-local-port': { class: 'internal' },
  'call-video-relay-side-b-local-port': { class: 'internal' },
  'call-orig-ip-address': { class: 'internal' },
  'call-term-ip-address': { class: 'internal' },
  'call-orig-from-host': { class: 'internal' },
  'call-orig-request-host': { class: 'internal' },
  'call-orig-to-host': { class: 'internal' },
  'call-orig-from-uri': { class: 'internal' },
  'call-orig-match-uri': { class: 'internal' },
  'call-orig-pre-routing-uri': { class: 'internal' },
  'call-orig-request-uri': { class: 'internal' },
  'call-orig-to-uri': { class: 'internal' },
  'call-routing-match-uri': { class: 'internal' },
  'call-term-match-uri': { class: 'internal' },
  'call-term-pre-routing-uri': { class: 'internal' },
  'call-term-to-uri': { class: 'internal' },
  'call-through-uri': { class: 'internal' },
  'call-server-mac-address': { class: 'internal' },
  'core-server': { class: 'internal' },
  'call-disposition-direction': { class: 'metadata' },
  name: { class: 'metadata' },
  number: { class: 'metadata' },
  onnet: { class: 'metadata' },
  uid: { class: 'record_id', recordType: 'user' },
 },

 // Active Calls
 ActiveCall: {
  'call-session-id': { class: 'record_id', recordType: 'call' },
  'call-orig-call-id': { class: 'record_id', recordType: 'call' },
  'call-term-call-id': { class: 'record_id', recordType: 'call' },
  'call-by-call-id': { class: 'record_id', recordType: 'call' },
  'core-server': { class: 'internal' },
  'call-orig-match-uri': { class: 'internal' },
  'call-orig-uri': { class: 'internal' },
  'call-term-uri': { class: 'internal' },
 },

 // Call Intelligence Transcriptions
 Transcription: {
  'call-id': { class: 'record_id', recordType: 'call' },
  'call-intelligence-summary': { class: 'content', kind: 'ai_summary', media: 'text' },
  'call-intelligence-segments': { class: 'content', kind: 'transcript', media: 'text' },
  'call-intelligence-topics-top': { class: 'content', kind: 'ai_summary', media: 'text' },
  'call-intelligence-topics-all': { class: 'content', kind: 'ai_summary', media: 'text' },
 },

 // SMS and Chat Messages
 Message: {
  id: { class: 'record_id', recordType: 'message' },
  text: { class: 'content', kind: 'sms_text', media: 'text' },
  'meeting-instance-id': { class: 'internal' },
  'messagesession-receiver-hostname': { class: 'internal' },
 },
 Messagesession: {
  'messagesession-id': { class: 'record_id', recordType: 'messagesession' },
  'messagesession-last-message': { class: 'content', kind: 'sms_text', media: 'text' },
  'messagesession-receiver-hostname': { class: 'internal' },
  'session-name': { class: 'metadata' },
 },
 MessageSend: {
  message: { class: 'content', kind: 'sms_text', media: 'text' },
 },

 // Audio and Recordings
 Recording: {
  'call-id': { class: 'record_id', recordType: 'call' },
  'call-recording-remote-wav': { class: 'content', kind: 'call_recording', media: 'audio_url' },
  'file-access-url': { class: 'content', kind: 'call_recording', media: 'audio_url' },
 },
 RecordingOld: {
  call_id: { class: 'record_id', recordType: 'call' },
  url: { class: 'content', kind: 'call_recording', media: 'audio_url' },
 },
 Audiofile: {
  transcription: { class: 'content', kind: 'transcript', media: 'text' },
 },

 // Credentials and Secrets (Scrubbed on every deployment)
 Device: {
  device: { class: 'record_id', recordType: 'device' },
  'device-sip-registration-password': { class: 'secret' },
  'device-provisioning-password': { class: 'secret' },
 },
 DeviceLegacy: {
  authentication_key: { class: 'secret' },
  auth_pass: { class: 'secret' },
 },
 User: {
  user: { class: 'record_id', recordType: 'user' },
  'voicemail-login-pin': { class: 'secret' },
  'directory-annouce-in-dial-by-name-enabled': { class: 'metadata' },
  vmailType: { class: 'metadata' },
  'voicemail-playback-announce-date-time-received': { class: 'metadata' },
  'iotum-video-host-id': { class: 'internal' },
  sso_ids: { class: 'internal' },
  mfa: { class: 'secret' },
 },
 UserLegacy: {
  subscriber_pin: { class: 'secret' },
  pwd_hash: { class: 'secret' },
  pwd: { class: 'secret' },
 },
 AnswerruleLegacy: {
  pwd: { class: 'secret' },
  pwd_hash: { class: 'secret' },
 },
 Domain: {
  domain: { class: 'record_id', recordType: 'domain' },
  'email-send-smtp-password': { class: 'secret' },
 },
 DomainLegacy: {
  smtp_pwd: { class: 'secret' },
 },
 Reseller: {
  'email-send-smtp-password': { class: 'secret' },
  smtp_pwd: { class: 'secret' },
 },
 AuthRequest: {
  client_secret: { class: 'secret' },
  password: { class: 'secret' },
 },
 AuthRequestMFA: {
  client_secret: { class: 'secret' },
  password: { class: 'secret' },
  passcode: { class: 'secret' },
  access_token: { class: 'secret' },
 },
 SSOEnroll: {
  client_secret: { class: 'secret' },
  password: { class: 'secret' },
  idtoken: { class: 'secret' },
 },
 AccessToken: {
  access_token: { class: 'secret' },
  refresh_token: { class: 'secret' },
 },
 ApiKey: {
  'key-id': { class: 'record_id', recordType: 'api_key' },
  key: { class: 'secret' },
 },
 NdpPhone: {
  'device-provisioning-password': { class: 'secret' },
  'device-sip-registration-password': { class: 'secret' },
  'global-one-time-pass': { class: 'secret' },
 },
 Meeting: {
  'meeting-passcode': { class: 'secret' },
 },
 Connection: {
  'connection-sip-registration-password': { class: 'secret' },
 },
 ConnectionExtra: {
  'connection-sip-registration-password': { class: 'secret' },
 },
 JwtRequestSuccess: {
  token: { class: 'secret' },
  refresh: { class: 'secret' },
 },
 Chart: {
  data_token: { class: 'secret' },
 },
 IotumHost: {
  password: { class: 'secret' },
 },
 Conference: {
  leader_pin: { class: 'secret' },
  speaker_pin: { class: 'secret' },
  participants_pin: { class: 'secret' },
  SipSipAuthKey: { class: 'secret' },
 },
 ConferenceParticipant: {
  pin: { class: 'secret' },
 },
 OIDCProvider: {
  'client-secret': { class: 'secret' },
 },

 // Record IDs for common entities
 CallQueue: {
  callqueue: { class: 'record_id', recordType: 'callqueue' },
  agent_loggedin_count: { class: 'metadata' },
 },
 Agent: {
  'callqueue-agent-id': { class: 'record_id', recordType: 'agent' },
  sub_portal_status: { class: 'metadata' },
  auto_ans: { class: 'metadata' },
  'name-first-name': { class: 'metadata' },
  'name-last-name': { class: 'metadata' },
  'ordinal-order': { class: 'metadata' },
  queue_list: { class: 'metadata' },
  queue_list_status: { class: 'metadata' },
  sub_scope: { class: 'metadata' },
  sub_site: { class: 'metadata' },
 },
 Phonenumber: {
  phonenumber: { class: 'record_id', recordType: 'phonenumber' },
 },
 Contact: {
  'unique-id': { class: 'record_id', recordType: 'contact' },
 },
 Answerrule: {
  'time-frame': { class: 'record_id', recordType: 'timeframe' },
  'ordinal-priority': { class: 'metadata' },
  parameters: { class: 'metadata' },
 },
 Timeframe: {
  'time-frame': { class: 'record_id', recordType: 'timeframe' },
 },
 Site: {
  site: { class: 'record_id', recordType: 'site' },
 },
 DialRule: {
  'dial-rule-matching-pattern': { class: 'record_id', recordType: 'dialrule' },
 },
 AutoAttendant: {
  'attendant-name': { class: 'record_id', recordType: 'auto_attendant' },
 },
 Count: {
  total: { class: 'metadata' },
  'total-duration': { class: 'metadata' },
  minutes: { class: 'metadata' },
  seconds: { class: 'metadata' },
  success: { class: 'metadata' },
 },
 QueueStat: {
  'agent-name': { class: 'metadata' },
  'queue-calls-answered-count': { class: 'metadata' },
  'queue-calls-talking-avg-duration-minutes': { class: 'metadata' },
  'queue-calls-holding-avg-duration-seconds': { class: 'metadata' },
  'queue-calls-handling-avg-duration-minutes': { class: 'metadata' },
  'queue-calls-talking-duration-minutes': { class: 'metadata' },
 },
};

/**
 * Resources not present in OpenAPI spec components.schemas that are declared from fixtures.
 */
export const CUSTOM_RESOURCES: Record<string, Record<string, FieldClass>> = {
 // Voicemail has no schema in OpenAPI v2 spec; fields declared from fixtures and client responses
 Voicemail: {
  id: { class: 'record_id', recordType: 'voicemail' },
  filename: { class: 'record_id', recordType: 'voicemail' },
  user: { class: 'metadata' },
  domain: { class: 'metadata' },
  folder: { class: 'metadata' },
  'caller-id-number': { class: 'metadata' },
  'caller-id-name': { class: 'metadata' },
  caller: { class: 'metadata' },
  from: { class: 'metadata' },
  name: { class: 'metadata' },
  time: { class: 'metadata' },
  created: { class: 'metadata' },
  datetime: { class: 'metadata' },
  duration: { class: 'metadata' },
  object: { class: 'metadata' },
  data: { class: 'metadata' },
  format: { class: 'metadata' },
  index: { class: 'metadata' },
  FromName: { class: 'metadata' },
  NmsAni: { class: 'metadata' },
  NmsRecDuration: { class: 'metadata' },
  'created-datetime': { class: 'metadata' },
  'file-duration-seconds': { class: 'metadata' },
  'file-size-kilobytes': { class: 'metadata' },
  'file-source': { class: 'metadata' },
  'recorded-datetime': { class: 'metadata' },
  'voicemail-recording-started-datetime': { class: 'metadata' },
  timezone: { class: 'metadata' },
  'text-to-speech-voice-id': { class: 'metadata' },
  'text-to-speech-language': { class: 'metadata' },
  'voicemail-from-name': { class: 'metadata' },
  'voicemail-from-user': { class: 'metadata' },
  'voicemail-from-host': { class: 'internal' },
  'voicemail-from-caller-id-number': { class: 'metadata' },
  'file-script-text': { class: 'content', kind: 'voicemail', media: 'text' },
  'transcription-text': { class: 'content', kind: 'transcript', media: 'text' },
  transcription: { class: 'content', kind: 'transcript', media: 'text' },
  transcript: { class: 'content', kind: 'transcript', media: 'text' },
  'voicemail-transcription': { class: 'content', kind: 'transcript', media: 'text' },
  'vmail-transcription': { class: 'content', kind: 'transcript', media: 'text' },
  transcription_text: { class: 'content', kind: 'transcript', media: 'text' },
  'file-access-url': { class: 'content', kind: 'voicemail', media: 'audio_url' },
  url: { class: 'content', kind: 'voicemail', media: 'audio_url' },
  file: { class: 'content', kind: 'voicemail', media: 'audio_url' },
  at: { class: 'metadata' },
 },

 // SIP flow / call trace response
 CallTrace: {
  type: { class: 'metadata' },
  servers: { class: 'metadata' },
  data: { class: 'metadata' },
  sql: { class: 'metadata' },
  svg: { class: 'metadata' },
 },

 // Handset provisioned phone from /domains/{domain}/phones
 Phone: {
  device: { class: 'record_id', recordType: 'device' },
  mac: { class: 'record_id', recordType: 'device' },
  'device-provisioning-mac-address': { class: 'record_id', recordType: 'device' },
  'device-provisioning-password': { class: 'secret' },
  'device-sip-registration-password': { class: 'secret' },
  'global-one-time-pass': { class: 'secret' },
  auth_pass: { class: 'secret' },
  authentication_key: { class: 'secret' },
  user: { class: 'metadata' },
  domain: { class: 'metadata' },
  reseller: { class: 'metadata' },
  notes: { class: 'metadata' },
  'device-models-brand-and-model': { class: 'metadata' },
  'device-models-model': { class: 'metadata' },
  'device-sip-registration-user-agent': { class: 'metadata' },
  'device-sip-registration-state': { class: 'metadata' },
  'device-sip-registration-uri': { class: 'metadata' },
  'device-provisioning-line-1-extensions': { class: 'metadata' },
  'device-provisioning-username': { class: 'metadata' },
 },
};
