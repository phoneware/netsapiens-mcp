import { afterEach, expect } from 'vitest';
import type { GenericApiClient } from '../generated/types.js';
import type { CuratedTool } from '../tools/curated/types.js';
import type { handleToolCall } from '../tools/index.js';
import { normalizeOperationKey } from '../netsapiens/operation-key.js';

const violations: string[] = [];

afterEach(() => {
 const found = violations.splice(0);
 expect(found, 'Curated requests outside the declared operations').toEqual([]);
});

export function recordingClient<T extends GenericApiClient>(tool: CuratedTool, client: T): T {
 return new Proxy(client, {
  get(target, property, receiver) {
   if (property !== 'request') return Reflect.get(target, property, receiver);
   return (request: { method: string; pathTemplate: string }) => {
    const key = normalizeOperationKey(request.method, request.pathTemplate);
    if (!tool.operations.includes(key)) violations.push(`${tool.schema.name}: ${key}`);
    return target.request(request as never);
   };
  },
 });
}

export function recordCuratedHandlers(tools: readonly CuratedTool[]): void {
 for (const tool of new Set(tools)) {
  const handler = tool.handler;
  tool.handler = (args, client, role) => handler(args, recordingClient(tool, client), role);
 }
}

export function recordCuratedDispatch(dispatch: typeof handleToolCall, tools: readonly CuratedTool[]): typeof handleToolCall {
 return (client, name, args, role, identity) => {
  const tool = tools.find((candidate) => candidate.schema.name === name);
  return dispatch(tool ? recordingClient(tool, client) : client, name, args, role, identity);
 };
}
