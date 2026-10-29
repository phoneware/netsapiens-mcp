import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { ENV_VARS } from '../config/env.js';

function sourceFiles(dir: string): string[] {
 return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  if (entry.name === '__tests__') return [];
  const path = join(dir, entry.name);
  return entry.isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
 });
}

describe('environment registry', () => {
 it('matches all static environment reads and reserved store settings', () => {
  const names = new Set<string>();
  for (const file of sourceFiles(join(process.cwd(), 'src'))) {
   const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
   const visit = (node: ts.Node): void => {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && node.expression.getText(source) === 'process.env') {
     if (ts.isPropertyAccessExpression(node)) names.add(node.name.text);
     else if (node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) names.add(node.argumentExpression.text);
    }
    ts.forEachChild(node, visit);
   };
   visit(source);
  }
  const registered = ENV_VARS.map((item) => item.name);
  expect(new Set(registered).size).toBe(registered.length);
  expect([...registered].sort()).toEqual([...new Set([...names, 'MCP_STORE_NAMESPACE', 'MCP_STORE_PATH'])].sort());
 });
});
