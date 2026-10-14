export type ContentKind = 'call_recording' | 'transcript' | 'voicemail' | 'sms_text' | 'ai_summary' | 'fax_page';

export type FieldClass =
  | { class: 'metadata' }
  | { class: 'record_id'; recordType: string }
  | { class: 'secret' } // dropped at every level, every deployment
  | { class: 'internal' } // plumbing (e.g. prefilled-transcription-api); dropped from output
  | { class: 'content'; kind: ContentKind; media: 'text' | 'audio_url' | 'document' };

export type NsResourceName = string;

/** Path grammar: '.'-separated keys, '[]' = every array element, '*' = any one key. First match wins. */
export type FieldRule = { path: string; field: FieldClass } | { path: string; resource: NsResourceName };

export interface OutputDeclaration {
  rules: readonly FieldRule[];
}

export interface ToolTargets {
  domainArg?: string; // argument naming a domain (absent = '~')
  userArg?: string; // argument naming a user/extension
  agentArg?: string; // argument naming a queue agent
  breadthArg?: { name: string; selfValue: string };
  selfOnly?: boolean; // always acts on the token owner ('~')
}

export type NsResourceFields = Record<string, Record<string, FieldClass>>;

export interface ScrubResult<T = unknown> {
  scrubbed: T;
  count: number;
}
