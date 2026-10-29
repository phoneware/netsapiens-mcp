import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CURATED_CATALOG } from '../tools/curated/catalog.js';
import { WORKFLOW_TOOLS } from '../tools/curated/workflows.js';
import { normalizeOperationKey } from '../netsapiens/operation-key.js';

describe('curated operation declarations', () => {
 it('normalizes methods, parameters, suffixes and root paths', () => {
  expect(normalizeOperationKey('get', '/domains/~/users/{user}/#2')).toBe('GET /domains/{}/users/{}');
  expect(normalizeOperationKey('post', '?object=address&action=copyEndpoint')).toBe('POST ?object=address&action=copyEndpoint');
  expect(normalizeOperationKey('get', '/')).toBe('GET /');
  expect(() => normalizeOperationKey('trace', '/')).toThrow();
 });

 it.each(['catalog.ts', 'workflows.ts', 'queue-agent.ts', 'voicemail-transcripts.ts'])('declares every literal request in %s', (file) => {
  const path = fileURLToPath(new URL(`../tools/curated/${file}`, import.meta.url));
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const workflows = new Set(WORKFLOW_TOOLS);
  const tools = file === 'catalog.ts' ? CURATED_CATALOG.filter((tool) => !workflows.has(tool))
   : file === 'workflows.ts' ? WORKFLOW_TOOLS : CURATED_CATALOG;
  const declared = new Set(tools.flatMap((tool) => [...tool.operations]));
  let checked = 0;
  function visit(node: ts.Node): void {
   if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'request') {
    const arg = node.arguments[0];
    if (arg && ts.isObjectLiteralExpression(arg)) {
     const property = (name: string) => arg.properties.find((p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && p.name.getText(source) === name);
     const method = property('method')?.initializer;
     const pathTemplate = property('pathTemplate')?.initializer;
     if (method && pathTemplate && ts.isStringLiteral(method) && ts.isStringLiteral(pathTemplate)) {
      const key = normalizeOperationKey(method.text, pathTemplate.text);
      expect(declared.has(key), `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${key}`).toBe(true);
      checked++;
     }
    }
   }
   ts.forEachChild(node, visit);
  }
  visit(source);
  expect(checked).toBeGreaterThan(0);
 });

 it('records queue health requests against its own declaration', async () => {
  const tool = WORKFLOW_TOOLS.find((item) => item.schema.name === 'queue_health')!;
  const calls: string[] = [];
  const client = {
   request: async (options: { method: string; pathTemplate: string }) => {
    calls.push(normalizeOperationKey(options.method, options.pathTemplate));
    return { success: true, data: options.pathTemplate.endsWith('/callqueues') ? [{ callqueue: 'support' }] : {} };
   },
  };
  await tool.handler({}, client as never, 'domain_admin');
  expect(calls).toHaveLength(2);
  for (const key of calls) expect(tool.operations, key).toContain(key);
 });
});
