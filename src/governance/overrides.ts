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
    'call-intelligence-topics-top': { class: 'content', kind: 'ai_summary', media: 'text' },
    'prefilled-transcription-api': { class: 'internal' },
    'prefilled-trace-api': { class: 'internal' },
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
  },
  Messagesession: {
    'messagesession-id': { class: 'record_id', recordType: 'messagesession' },
    'messagesession-last-message': { class: 'content', kind: 'sms_text', media: 'text' },
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
  },
  Agent: {
    'callqueue-agent-id': { class: 'record_id', recordType: 'agent' },
  },
  Phonenumber: {
    phonenumber: { class: 'record_id', recordType: 'phonenumber' },
  },
  Contact: {
    'unique-id': { class: 'record_id', recordType: 'contact' },
  },
  Answerrule: {
    'time-frame': { class: 'record_id', recordType: 'timeframe' },
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
    'transcription-text': { class: 'content', kind: 'transcript', media: 'text' },
    transcription: { class: 'content', kind: 'transcript', media: 'text' },
    transcript: { class: 'content', kind: 'transcript', media: 'text' },
    'voicemail-transcription': { class: 'content', kind: 'transcript', media: 'text' },
    'vmail-transcription': { class: 'content', kind: 'transcript', media: 'text' },
    transcription_text: { class: 'content', kind: 'transcript', media: 'text' },
    'file-access-url': { class: 'content', kind: 'voicemail', media: 'audio_url' },
    url: { class: 'content', kind: 'voicemail', media: 'audio_url' },
    file: { class: 'content', kind: 'voicemail', media: 'audio_url' },
  },

  // SIP flow / call trace response
  CallTrace: {
    type: { class: 'metadata' },
    servers: { class: 'metadata' },
    data: { class: 'metadata' },
    sql: { class: 'metadata' },
    svg: { class: 'metadata' },
  },
};
