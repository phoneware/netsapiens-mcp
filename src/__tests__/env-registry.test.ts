import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { ENV_VARS } from '../config/env.js';

function sourceFiles(dir: string): string[] {
 return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  if (entry.name === '__tests__') return [];
  const path = join(dir, entry.name);
  return entry.isDirectory() ? sourceFiles(path) : /\.(?:ts|tsx|mts|cts)$/.test(path) ? [path] : [];
 });
}

function envNames(text: string, file = 'fixture.ts'): Set<string> {
 const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
 const names = new Set<string>();
 const visit = (node: ts.Node): void => {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
   const property = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
   const target = node.expression.getText(source);
   if (property === 'env' && (target === 'process' || target === 'globalThis.process')) {
    const parent = node.parent;
    const staticAccess = (ts.isPropertyAccessExpression(parent) && parent.expression === node && !parent.questionDotToken)
     ? parent.name.text
     : (ts.isElementAccessExpression(parent) && parent.expression === node && !parent.questionDotToken && ts.isStringLiteral(parent.argumentExpression))
      ? parent.argumentExpression.text : undefined;
    if (target !== 'process' || node.questionDotToken || !staticAccess || (ts.isElementAccessExpression(node))) {
     throw new Error(`Unsupported process.env reference in ${file}: ${node.parent.getText(source)}`);
    }
    names.add(staticAccess);
   }
  }
  ts.forEachChild(node, visit);
 };
 visit(source);
 return names;
}

describe('environment registry', () => {
 it('matches all static environment reads and reserved store settings', () => {
  const names = new Set<string>();
  for (const file of sourceFiles(join(process.cwd(), 'src'))) {
   for (const name of envNames(readFileSync(file, 'utf8'), file)) names.add(name);
  }
  const registered = ENV_VARS.map((item) => item.name);
  expect(new Set(registered).size).toBe(registered.length);
  expect([...registered].sort()).toEqual([...new Set([...names, 'MCP_STORE_NAMESPACE', 'MCP_STORE_PATH'])].sort());
 });

 it.each([
  'const {X} = process.env',
  'const env = process.env',
  'process.env[key]',
  'process.env[`X`]',
  'process?.env.X',
  'globalThis.process.env.X',
  "'X' in process.env",
  'process.env?.X',
  "process['env'].X",
 ])('rejects untrackable reference %s', (fixture) => {
  expect(() => envNames(fixture)).toThrow('Unsupported process.env reference');
 });
 it('accepts dot and quoted static reads', () => {
  expect([...envNames("process.env.FOO; process.env['BAR']")].sort()).toEqual(['BAR', 'FOO']);
 });
});
