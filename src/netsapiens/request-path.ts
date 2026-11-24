/**
 * How a v2 request path is built, and what the HTTP layer resolves it to.
 *
 * The client fills a path template by encoding each value with encodeURIComponent, and axios then joins the result to
 * the API base and parses it with new URL(). encodeURIComponent leaves "." alone, so the value ".." reaches the URL as
 * a dot segment and new URL() removes it. The operation key then names one endpoint while the request reaches another:
 * servicecode/../transcriptions is keyed as a servicecode read and sent as a transcription read. This module expands a
 * template the way the client always has, refuses the values that could change the path, and checks that the path the
 * HTTP layer will send is the expansion, segment for segment.
 */
import { normalizeOperationKey } from './operation-key.js';

/** The path every v2 request is joined to. The client's axios baseURL is `${apiUrl}${V2_BASE_PATH}`. */
export const V2_BASE_PATH = '/ns-api/v2';

/**
 * Why a path value is refused. "empty" and "dot_segment" refuse in every mode. The other two refuse only in registry
 * mode: a real resource name could contain them, so the shared request path must keep sending them as before.
 */
export type PathValueRefusal = 'empty' | 'dot_segment' | 'separator' | 'control';

const DOT_SEGMENTS: Readonly<Record<string, true>> = { '.': true, '..': true };
const SEPARATOR = /[/\\]/;
const ENCODED_SEPARATOR = /%2f|%5c/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const PLACEHOLDER = /\{[^{}]*\}/;
const PLACEHOLDER_ORIGIN = 'https://netsapiens.invalid';

/** One round of percent-decoding. Text that is not a valid escape sequence comes back unchanged. */
function decodeOnce(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The value followed by each decoding of it, up to three rounds, so "%252e%252e" is seen as "..". */
function decodings(value: string): string[] {
  const forms = [value];
  for (let round = 0; round < 3; round++) {
    const next = decodeOnce(forms[forms.length - 1]);
    if (next === forms[forms.length - 1]) break;
    forms.push(next);
  }
  return forms;
}

/**
 * Why a path value is refused, or undefined when it may be expanded into a path. A value is refused when it is empty
 * or when any decoding of it is a dot segment. In `strict` (registry) mode it is also refused for a slash or
 * backslash, a percent-encoded slash or backslash, or a control character, in any decoding.
 */
export function pathValueRefusal(value: string, strict: boolean): PathValueRefusal | undefined {
  if (value === '') return 'empty';
  const forms = decodings(value);
  if (forms.some((form) => Object.hasOwn(DOT_SEGMENTS, form))) return 'dot_segment';
  if (!strict) return undefined;
  if (ENCODED_SEPARATOR.test(value) || forms.some((form) => SEPARATOR.test(form))) return 'separator';
  if (forms.some((form) => CONTROL.test(form))) return 'control';
  return undefined;
}

/** The first path parameter that is refused, in the order the parameters were given. */
export function pathParameterRefusal(
  pathParams: Readonly<Record<string, unknown>> | undefined,
  strict: boolean,
): { readonly name: string; readonly reason: PathValueRefusal } | undefined {
  if (pathParams === undefined) return undefined;
  for (const [name, value] of Object.entries(pathParams)) {
    if (value === undefined || value === null) continue;
    const reason = pathValueRefusal(String(value), strict);
    if (reason !== undefined) return { name, reason };
  }
  return undefined;
}

/** The message a refused path parameter gets. It names the parameter and the reason, never the value. */
export function pathRefusalMessage(name: string, reason: PathValueRefusal): string {
  const described: Record<PathValueRefusal, string> = {
    empty: 'empty',
    dot_segment: 'a dot segment',
    separator: 'a path separator',
    control: 'a control character',
  };
  return `The request was not sent: path parameter '${name}' is ${described[reason]}.`;
}

/**
 * The path a template expands to: each `{name}` replaced by its encoded value. This is the expansion the client has
 * always made, and it is the single place that makes it.
 */
export function expandPathTemplate(template: string, pathParams: Readonly<Record<string, unknown>> | undefined): string {
  let url = template;
  if (pathParams) {
    for (const [key, value] of Object.entries(pathParams)) {
      if (value === undefined || value === null) continue;
      url = url.replace(new RegExp(`\\{${key}\\}`, 'g'), encodeURIComponent(String(value)));
    }
  }
  return url;
}

/** Whether text still holds a `{name}` placeholder, which means a path parameter was not supplied. */
export function hasPlaceholder(text: string): boolean {
  return PLACEHOLDER.test(text);
}

/**
 * The path below V2_BASE_PATH that the HTTP layer sends for an expanded template, or undefined when the path changes
 * on the way. axios joins a relative url to its baseURL with combineURLs, which drops the url's leading slashes, and the
 * adapter parses the result with new URL(). This performs the same join and parse. The origin is a placeholder: a path
 * cannot change it, and whether a path normalizes does not depend on the origin.
 */
export function finalPathBelowBase(expanded: string): string | undefined {
  if (!expanded.startsWith('/')) return undefined;
  const expectedPath = `${V2_BASE_PATH}/${expanded.replace(/^\/+/, '')}`;
  let resolved: URL;
  try {
    resolved = new URL(`${PLACEHOLDER_ORIGIN}${expectedPath}`);
  } catch {
    return undefined;
  }
  if (resolved.origin !== PLACEHOLDER_ORIGIN || resolved.search !== '' || resolved.hash !== '') return undefined;
  if (resolved.pathname !== expectedPath) return undefined;
  return expectedPath.slice(V2_BASE_PATH.length);
}

/**
 * The operation key of the request the HTTP layer will send for an expanded template, or undefined when that path no
 * longer has the template's shape. A segment that holds a value is keyed as the template keys it, and every other
 * segment must be exactly the literal the template names. A removed dot segment, a value that adds a segment, a value
 * that empties a placeholder, and a template whose literals collapse all leave no key.
 */
export function operationKeyOfFinalPath(method: string, template: string, expanded: string): string | undefined {
  const below = finalPathBelowBase(expanded);
  if (below === undefined) return undefined;
  const templateSegments = template.split('/');
  const expandedSegments = expanded.split('/');
  const finalSegments = below.split('/');
  if (expandedSegments.length !== templateSegments.length || finalSegments.length !== templateSegments.length) {
    return undefined;
  }
  const keyed: string[] = [];
  for (let index = 0; index < templateSegments.length; index++) {
    const segment = finalSegments[index];
    if (segment !== expandedSegments[index]) return undefined;
    const isValue = hasPlaceholder(templateSegments[index]);
    if (isValue && segment === '') return undefined;
    keyed.push(isValue ? templateSegments[index] : segment);
  }
  return normalizeOperationKey(method, keyed.join('/'));
}
