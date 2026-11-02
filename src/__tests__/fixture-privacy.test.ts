import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Live fixtures carry value-free shapes rather than real data.
 * Every string must be literal "s", every number 0, arrays at most 2 elements,
 * and object keys must match allowed NetSapiens field names or k<n>.
 */
const DIR = resolve(__dirname, 'fixtures/live');
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

const NS_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_-]*$|^[345]-digit-dial-by-extension$|^k\d+$/;
const NS_SPEC_CAMEL_KEYS: Record<string, true> = {
 vmailType: true,
 maxCallMinute: true,
};

export function findPrivacyViolations(val: unknown, currentPath = ''): string[] {
 const violations: string[] = [];

 if (val === null || val === undefined || typeof val === 'boolean') {
  return violations;
 }

 if (typeof val === 'string') {
  if (val !== 's') {
   violations.push(`string value at ${currentPath || 'root'} is not "s": ${JSON.stringify(val).slice(0, 30)}`);
  }
  return violations;
 }

 if (typeof val === 'number') {
  if (val !== 0) {
   violations.push(`number value at ${currentPath || 'root'} is not 0: ${val}`);
  }
  return violations;
 }

 if (Array.isArray(val)) {
  if (val.length > 2) {
   violations.push(`array at ${currentPath || 'root'} has length ${val.length} (max 2 allowed)`);
  }
  for (let i = 0; i < val.length; i++) {
   violations.push(...findPrivacyViolations(val[i], `${currentPath}[${i}]`));
  }
  return violations;
 }

 if (typeof val === 'object') {
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
   if (!NS_FIELD_KEY_PATTERN.test(k) && !NS_SPEC_CAMEL_KEYS[k]) {
    violations.push(`object key "${k}" at ${currentPath || 'root'} does not match NetSapiens field or k<n> pattern`);
   }
   const propPath = currentPath ? `${currentPath}.${k}` : k;
   violations.push(...findPrivacyViolations(v, propPath));
  }
  return violations;
 }

 violations.push(`unexpected type at ${currentPath || 'root'}: ${typeof val}`);
 return violations;
}

describe('live fixtures are value-free shapes', () => {
 it('has fixtures to check', () => {
  expect(files.length).toBeGreaterThan(0);
 });

 it.each(files)('%s conforms to shape rules', (file) => {
  const payload = JSON.parse(readFileSync(resolve(DIR, file), 'utf8'));
  expect(findPrivacyViolations(payload)).toEqual([]);
 });

 it('fails on raw samples with real data or non-shape values', () => {
  // Non-"s" string values
  expect(findPrivacyViolations({ name: 'Jane Doe' })).toContain(
   'string value at name is not "s": "Jane Doe"'
  );
  expect(findPrivacyViolations({ phone: '6025550100' })).toContain(
   'string value at phone is not "s": "6025550100"'
  );

  // Non-0 number values
  expect(findPrivacyViolations({ count: 42 })).toContain(
   'number value at count is not 0: 42'
  );

  // Array length > 2
  expect(findPrivacyViolations({ items: ['s', 's', 's'] })).toContain(
   'array at items has length 3 (max 2 allowed)'
  );

  // Keys that are data (leading digit, emails, non-standard names)
  expect(findPrivacyViolations({ '1001': 's' })).toContain(
   'object key "1001" at root does not match NetSapiens field or k<n> pattern'
  );
  expect(findPrivacyViolations({ 'user@example.com': 's' })).toContain(
   'object key "user@example.com" at root does not match NetSapiens field or k<n> pattern'
  );
  expect(findPrivacyViolations({ 'Invalid Key Name': 's' })).toContain(
   'object key "Invalid Key Name" at root does not match NetSapiens field or k<n> pattern'
  );

  // Conforming shape passes
  expect(
   findPrivacyViolations({
    success: true,
    data: [
     { id: 's', domain: 's', count: 0, k0: { stats: 0 } },
     { id: 's', domain: 's', count: 0, k1: { stats: 0 } },
    ],
   })
  ).toEqual([]);
 });
});
