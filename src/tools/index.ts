import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { NetSapiensClient } from '../netsapiens-client.js';

import * as system from './system.js';
import * as resellers from './resellers.js';
import * as domains from './domains.js';
import * as sites from './sites.js';
import * as users from './users.js';
import * as phoneNumbers from './phone-numbers.js';
import * as callQueues from './call-queues.js';
import * as cdrs from './cdrs.js';
import * as calls from './calls.js';
import * as conferences from './conferences.js';
import * as autoAttendants from './auto-attendants.js';
import * as answerRules from './answer-rules.js';
import * as timeframes from './timeframes.js';
import * as greetings from './greetings.js';
import * as voicemails from './voicemails.js';
import * as musicOnHold from './music-on-hold.js';
import * as contacts from './contacts.js';
import * as phones from './phones.js';
import * as recordings from './recordings.js';
import * as messaging from './messaging.js';
import * as statistics from './statistics.js';
import * as dialPlans from './dial-plans.js';
import * as dialPolicy from './dial-policy.js';
import * as subscriptions from './subscriptions.js';
import * as routes from './routes.js';
import * as addresses from './addresses.js';
import * as numberFilters from './number-filters.js';
import * as holdMessages from './hold-messages.js';
import * as videoMeetings from './video-meetings.js';
import * as misc from './misc.js';

const toolModules = [
  system,
  resellers,
  domains,
  sites,
  users,
  phoneNumbers,
  callQueues,
  cdrs,
  calls,
  conferences,
  autoAttendants,
  answerRules,
  timeframes,
  greetings,
  voicemails,
  musicOnHold,
  contacts,
  phones,
  recordings,
  messaging,
  statistics,
  dialPlans,
  dialPolicy,
  subscriptions,
  routes,
  addresses,
  numberFilters,
  holdMessages,
  videoMeetings,
  misc,
];

/**
 * Returns all tool definitions from all modules.
 */
export function getAllToolDefinitions(): any[] {
  return toolModules.flatMap((m) => m.toolDefinitions as any[]);
}

/**
 * Dispatches a tool call to the appropriate module handler.
 * Returns the result or null if no module handles the tool.
 */
export async function handleToolCall(
  client: NetSapiensClient,
  toolName: string,
  args: any
): Promise<any> {
  for (const mod of toolModules) {
    const result = await mod.handleToolCall(client, toolName, args);
    if (result !== null) {
      return result;
    }
  }
  return null;
}

/**
 * Registers ListTools and CallTool handlers on an MCP Server.
 */
export function registerAllTools(server: Server, client: NetSapiensClient): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getAllToolDefinitions() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await handleToolCall(client, name, args);
      if (result !== null) {
        return result;
      }
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(
        ErrorCode.InternalError,
        `Error executing tool ${name}: ${error}`
      );
    }
  });
}
