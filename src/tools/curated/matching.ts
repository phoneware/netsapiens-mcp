/**
 * Client-side matching helpers.
 *
 * Several NetSapiens list endpoints (`/domains/{domain}/users`, `/domains`,
 * `/domains/{domain}/phonenumbers`, `/domains/{domain}/devices`,
 * `/domains/{domain}/users/{user}/contacts`, `/domains/{domain}/messagesessions`)
 * have no server-side filter for the field a "find X" tool searches on —
 * confirmed against the live NetSapiens OpenAPI spec, which lists only
 * `limit`/`start`/`includeDomain`-style pagination params for these routes.
 * Sending a made-up filter param (e.g. `user=`, `phonenumber=`) is silently
 * ignored by the API, so tools built on these endpoints must fetch broadly
 * and filter the response themselves.
 */

/** Case-insensitive substring match of `query` against any of `record`'s given fields. */
export function fieldsMatch(record: Record<string, unknown>, fields: string[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => {
    const v = record[f];
    return v != null && String(v).toLowerCase().includes(needle);
  });
}

/** Compare phone numbers loosely: strip everything but digits and match on the trailing 10 (NANP), so E.164 vs domestic formatting doesn't break equality. */
export function numbersMatch(haystack: string, number: string): boolean {
  const digits = (s: string) => s.replace(/\D/g, '');
  const needle = digits(number).slice(-10);
  if (!needle) return false;
  return digits(haystack).includes(needle);
}

/**
 * True if `dateValue` is on or after `since`. Used as a client-side backstop
 * for date filters: `datetime-start`/`datetime-end` are a REQUIRED PAIR on
 * NetSapiens CDR/statistics endpoints — sending `datetime-start` alone is
 * silently ignored and returns unbounded history (confirmed against live
 * data). Callers should always send both, but this backstop still filters
 * client-side in case a caller forgets or the server-side bound isn't
 * enforced as expected. Unparseable/missing dates are NOT excluded, since
 * dropping a record we can't evaluate is worse than an occasional false
 * positive.
 */
export function isOnOrAfter(dateValue: unknown, since: string): boolean {
  if (dateValue == null) return true;
  const t = Date.parse(String(dateValue));
  const s = Date.parse(since);
  if (Number.isNaN(t) || Number.isNaN(s)) return true;
  return t >= s;
}
