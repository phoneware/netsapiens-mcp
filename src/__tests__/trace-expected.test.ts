import { describe, it, expect } from 'vitest';
import { isNsTraceExpected, parseNsBoolean } from '../tools/curated/matching.js';

describe('isNsTraceExpected', () => {
 it('accepts boolean true', () => {
  expect(isNsTraceExpected(true)).toBe(true);
 });

 it('accepts string true and case variants', () => {
  expect(isNsTraceExpected('true')).toBe(true);
  expect(isNsTraceExpected('True')).toBe(true);
  expect(isNsTraceExpected('TRUE')).toBe(true);
 });

 it('accepts string yes and case variants', () => {
  expect(isNsTraceExpected('yes')).toBe(true);
  expect(isNsTraceExpected('Yes')).toBe(true);
  expect(isNsTraceExpected('YES')).toBe(true);
 });

 it('accepts number 1 and string 1', () => {
  expect(isNsTraceExpected(1)).toBe(true);
  expect(isNsTraceExpected('1')).toBe(true);
 });

 it('treats missing (null, undefined, empty string) as expected', () => {
  expect(isNsTraceExpected(null)).toBe(true);
  expect(isNsTraceExpected(undefined)).toBe(true);
  expect(isNsTraceExpected('')).toBe(true);
 });

 it('rejects boolean false', () => {
  expect(isNsTraceExpected(false)).toBe(false);
 });

 it('rejects string false and case variants', () => {
  expect(isNsTraceExpected('false')).toBe(false);
  expect(isNsTraceExpected('False')).toBe(false);
  expect(isNsTraceExpected('FALSE')).toBe(false);
 });

 it('rejects string no and case variants', () => {
  expect(isNsTraceExpected('no')).toBe(false);
  expect(isNsTraceExpected('No')).toBe(false);
  expect(isNsTraceExpected('NO')).toBe(false);
 });

 it('rejects number 0 and string 0', () => {
  expect(isNsTraceExpected(0)).toBe(false);
  expect(isNsTraceExpected('0')).toBe(false);
 });

 it('rejects arbitrary invalid values', () => {
  expect(isNsTraceExpected('expired')).toBe(false);
  expect(isNsTraceExpected('unknown')).toBe(false);
  expect(isNsTraceExpected(99)).toBe(false);
 });
});

describe('parseNsBoolean', () => {
 it('honors custom defaults when value is missing', () => {
  expect(parseNsBoolean(null, false)).toBe(false);
  expect(parseNsBoolean(undefined, false)).toBe(false);
  expect(parseNsBoolean('', false)).toBe(false);
  expect(parseNsBoolean(null, true)).toBe(true);
  expect(parseNsBoolean(undefined, true)).toBe(true);
  expect(parseNsBoolean('', true)).toBe(true);
 });

 it('parses boolean, numeric and string variants accurately', () => {
  expect(parseNsBoolean(true)).toBe(true);
  expect(parseNsBoolean('yes')).toBe(true);
  expect(parseNsBoolean('true')).toBe(true);
  expect(parseNsBoolean(1)).toBe(true);
  expect(parseNsBoolean(false)).toBe(false);
  expect(parseNsBoolean('no')).toBe(false);
  expect(parseNsBoolean('false')).toBe(false);
  expect(parseNsBoolean(0)).toBe(false);
 });
});
