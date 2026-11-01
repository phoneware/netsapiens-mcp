import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CURATED_CATALOG } from '../tools/curated/catalog.js';
import { WORKFLOW_TOOLS } from '../tools/curated/workflows.js';
import { normalizeOperationKey } from '../netsapiens/operation-key.js';
import { recordingClient } from './curated-operation-recorder.js';

// The existing peer handler sends a destination, but the documented peer route
// is a blind transfer while this tool describes an attended transfer. Its actual
// route is retained until that behavioral mismatch is resolved.
const KNOWN_UNDOCUMENTED_ROUTES = {
 transfer_call: ['PATCH /domains/{}/users/{}/calls/{}/transfer/peer'],
};

// Each entry is tied to the request expression, its tool, and every key it can
// reach. Changing the expression requires reviewing the keys again.
const NON_LITERAL_REQUESTS: Record<string, Array<{ expression: string; keys: string[]; reason: string }>> = {
 call_details: [
  { expression: "{ method: 'GET', ...cdrRoute, queryParams: filter }", keys: ['GET /domains/{}/cdrs', 'GET /domains/{}/users/{}/cdrs'], reason: 'role and scope select the CDR route' },
  { expression: "{ method: 'GET', ...cdrRoute, queryParams: filter }", keys: ['GET /domains/{}/users/{}/cdrs'], reason: 'scope rejection retries the user route' },
 ],
 transfer_call: [{ expression: "{\n   method: 'PATCH',\n   pathTemplate,\n   pathParams: { domain: str(args.domain), user: str(args.user), callid: String(args.call_id) },\n   body: { destination: String(args.to) },\n  }", keys: ['PATCH /domains/{}/users/{}/calls/{}/transfer', ...KNOWN_UNDOCUMENTED_ROUTES.transfer_call], reason: 'transfer type selects the path' }],
 call_statistics: [{ expression: "{\n   method: 'GET',\n   pathTemplate,\n   pathParams,\n   queryParams: { start_date: window.start, end_date: window.end },\n  }", keys: ['GET /domains/{}/statistics/callqueues/{}', 'GET /domains/{}/statistics/callqueues/aggregate'], reason: 'queue selects aggregate or individual statistics' }],
 agent_statistics: [{ expression: "{\n   method: 'GET',\n   pathTemplate,\n   pathParams,\n   queryParams: { start_date: window.start, end_date: window.end },\n  }", keys: ['GET /domains/{}/statistics/agent', 'GET /domains/{}/statistics/agent/{}'], reason: 'agent selects aggregate or individual statistics' }],
 set_hold_message: [{ expression: "{\n   method: replacing ? 'PUT' : 'POST',\n   pathTemplate,\n   pathParams,\n   multipart: { field: 'File', filename, base64: audio, contentType },\n  }", keys: ['POST /domains/{}/msg', 'PUT /domains/{}/msg/{}', 'POST /domains/{}/users/{}/msg', 'PUT /domains/{}/users/{}/msg/{}'], reason: 'scope and replacement select the method and path' }],
};


describe('curated operation declarations', () => {
 it('normalizes methods, parameters, suffixes and root paths', () => {
  expect(normalizeOperationKey('get', '/domains/~/users/{user}/#2')).toBe('GET /domains/{}/users/{}');
  expect(normalizeOperationKey('get', '/')).toBe('GET /');
  expect(() => normalizeOperationKey('trace', '/')).toThrow();
 });

 it('checks every request and rejects unresolved calls outside the allowlist', () => {
  const tools = new Map(CURATED_CATALOG.map((tool) => [tool.schema.name, tool]));
  const used = new Map<string, number>();
  let checked = 0;
  const files = ['catalog.ts', 'workflows.ts', 'queue-agent.ts', 'voicemail-transcripts.ts'];
  const sources = files.map((file) => {
   const path = fileURLToPath(new URL(`../tools/curated/${file}`, import.meta.url));
   return { file, source: ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true) };
  });
  const calls = new Map<string, Set<string>>();
  for (const { source } of sources) {
   function collect(node: ts.Node): void {
    if ((ts.isFunctionDeclaration(node) && node.name) ||
     (ts.isVariableDeclaration(node) && node.type?.getText(source) === 'CuratedTool')) {
     const name = node.name!.getText(source);
     const names = new Set<string>();
     function visitCalls(child: ts.Node): void {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) names.add(child.expression.text);
      ts.forEachChild(child, visitCalls);
     }
     ts.forEachChild(node, visitCalls);
     calls.set(name, names);
    }
    ts.forEachChild(node, collect);
   }
   collect(source);
  }
  const helperOwners = new Map<string, Set<string>>();
  for (const tool of tools.keys()) {
   const visited = new Set<string>();
   function walk(name: string): void {
    if (visited.has(name)) return;
    visited.add(name);
    if (calls.has(name) && name !== tool) {
     const owners = helperOwners.get(name) ?? new Set<string>();
     owners.add(tool);
     helperOwners.set(name, owners);
    }
    for (const callee of calls.get(name) ?? []) walk(callee);
   }
   walk(tool);
  }
  for (const { file, source } of sources) {
   function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'request') {
     let owner: ts.Node | undefined = node.parent;
     while (owner && !ts.isFunctionDeclaration(owner) && !(ts.isVariableDeclaration(owner) && owner.type?.getText(source) === 'CuratedTool')) owner = owner.parent;
     const name = owner && (ts.isFunctionDeclaration(owner) || ts.isVariableDeclaration(owner)) ? owner.name?.getText(source) : undefined;
     expect(name, `${file}: request has no recognized owner`).toBeTruthy();
     const owners = tools.has(name!) ? [name!] : [...(helperOwners.get(name!) ?? [])];
     expect(owners.length, `${file}: helper ${name} has no tool owner`).toBeGreaterThan(0);
     const arg = node.arguments[0];
     expect(arg && ts.isObjectLiteralExpression(arg), `${name}: request argument is not an object literal`).toBe(true);
     if (!arg || !ts.isObjectLiteralExpression(arg)) throw new Error(`${name}: unresolvable request`);
     const property = (propertyName: string) => arg.properties.find((p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && p.name.getText(source) === propertyName);
     const method = property('method')?.initializer;
     const pathTemplate = property('pathTemplate')?.initializer;
     let keys: string[];
     if (method && pathTemplate && ts.isStringLiteral(method) && ts.isStringLiteral(pathTemplate) && !arg.properties.some(ts.isSpreadAssignment)) {
      keys = [normalizeOperationKey(method.text, pathTemplate.text)];
     } else {
      const index = used.get(name!) ?? 0;
      const entry = NON_LITERAL_REQUESTS[name!]?.[index];
      expect(entry, `${name}: non-literal request is not allowlisted`).toBeDefined();
      if (!entry) throw new Error(`${name}: non-literal request is not allowlisted`);
      expect(arg.getText(source).replace(/\s+/g, ' '), `${name}: allowlist expression changed`).toBe(entry.expression.replace(/\s+/g, ' '));
      expect(entry.reason.length).toBeGreaterThan(0);
      used.set(name!, index + 1);
      keys = entry.keys;
     }
     for (const ownerName of owners) {
      const tool = tools.get(ownerName);
      expect(tool, `unknown request owner ${ownerName}`).toBeDefined();
      for (const key of keys) expect(tool!.operations, `${ownerName}: ${key}`).toContain(key);
     }
     checked++;
    }
    ts.forEachChild(node, visit);
   }
   visit(source);
  }
  for (const [name, entries] of Object.entries(NON_LITERAL_REQUESTS)) expect(used.get(name), name).toBe(entries.length);
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
  await tool.handler({}, recordingClient(tool, client as never), 'domain_admin');
  expect(calls).toHaveLength(2);
 });
});
