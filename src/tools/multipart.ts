/**
 * Operations that only accept `multipart/form-data`.
 *
 * The generator treats a multipart request body exactly like a JSON one, so it
 * emitted working-looking tools for all of these. They cannot work: our client
 * sends JSON, and these endpoints parse a raw multipart stream to pull the file
 * out. The model fills in a `File` argument, the call fails or does nothing, and
 * there is nothing in the tool description to suggest a different route.
 *
 * Every one of them has a JSON sibling that does the same job, either from
 * text-to-speech (`script`, `voice_id`) or from an inline `base64_file`. So the
 * fix is not to hide these, it is to fail fast and name the alternative.
 *
 * `spec-conformance.test.ts` re-derives this list from the spec and fails if it
 * drifts, so a spec update cannot leave it stale.
 */

export const MULTIPART_ONLY_OPERATIONS = new Set([
  'POST /domains/{domain}/msg',
  'POST /domains/{domain}/moh#1',
  'POST /domains/{domain}/users/{user}/greetings#3',
  'POST /domains/{domain}/users/{user}/moh#1',
  'POST /domains/{domain}/users/{user}/msg',
  'POST /images/{filename}#1',
  'PUT /domains/{domain}/moh/{index}#1',
  'PUT /domains/{domain}/msg/{index}',
  'PUT /domains/{domain}/users/{user}/greetings/{index}#3',
  'PUT /domains/{domain}/users/{user}/moh/{index}#1',
  'PUT /domains/{domain}/users/{user}/msg/{index}',
  'PUT /images/{filename}',
]);

/**
 * Tool names generated from those operations. Derived by the generator's own
 * naming scheme; `multipart.test.ts` asserts each one exists in the registry so
 * a rename cannot silently disarm this.
 */
export const MULTIPART_ONLY_TOOLS = new Set([
  'create_greeting_file_upload',
  'update_greeting_file_upload',
  'create_moh_domain_file_upload',
  'update_moh_domain_file_upload',
  'create_moh_user_file_upload',
  'update_moh_user_file_upload',
  'create_msg_domain_file_upload',
  'update_msg_domain_file_upload',
  'post_domains_by_domain_users_by_user_msg',
  'update_msg_user_file_upload',
  'create_image_file_upload',
  'update_image_file_upload',
]);

/** What to tell the model instead, per media family. */
export function multipartAlternative(toolName: string): string {
  if (/greeting/.test(toolName)) {
    return 'Use the greeting tool that takes `script` (text-to-speech) or `base64_file` (audio inlined as base64) instead.';
  }
  if (/moh/.test(toolName)) {
    return 'Use the music-on-hold tool that takes `script` (text-to-speech) or `base64_file` (audio inlined as base64) instead.';
  }
  if (/msg/.test(toolName)) {
    // The only family with no upload-free variant, so this one points at a
    // curated tool that sends real multipart rather than at a JSON sibling.
    return 'Use `set_hold_message`, which takes the audio as base64 and sends the multipart upload for you.';
  }
  if (/image/.test(toolName)) {
    return 'Use the image tool that takes the file inline as base64 instead.';
  }
  return 'Use the JSON variant of this operation, which takes the file inline rather than as an upload.';
}
