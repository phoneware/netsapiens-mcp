import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'list_active_calls',
    description: 'List active calls at domain or user level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level calls)' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'count_active_calls',
    description: 'Count active calls in a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'get_active_call',
    description: 'Get details of a specific active call',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        callId: { type: 'string', description: 'Call ID' },
      },
      required: ['domain', 'userId', 'callId'],
    },
  },
  {
    name: 'make_call',
    description: 'Initiate a new call',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID making the call' },
        to: { type: 'string', description: 'Destination number or SIP URI' },
        from: { type: 'string', description: 'Caller ID to use (optional)' },
      },
      required: ['domain', 'userId', 'to'],
    },
  },
  {
    name: 'disconnect_call',
    description: 'Disconnect an active call',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        callId: { type: 'string', description: 'Call ID to disconnect' },
      },
      required: ['domain', 'userId', 'callId'],
    },
  },
  {
    name: 'answer_call',
    description: 'Answer an incoming call',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        callId: { type: 'string', description: 'Call ID to answer' },
      },
      required: ['domain', 'userId', 'callId'],
    },
  },
  {
    name: 'hold_call',
    description: 'Place an active call on hold',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        callId: { type: 'string', description: 'Call ID to hold' },
      },
      required: ['domain', 'userId', 'callId'],
    },
  },
  {
    name: 'unhold_call',
    description: 'Take a call off hold',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        callId: { type: 'string', description: 'Call ID to unhold' },
      },
      required: ['domain', 'userId', 'callId'],
    },
  },
  {
    name: 'transfer_call',
    description: 'Transfer an active call to another destination',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        callId: { type: 'string', description: 'Call ID to transfer' },
        to: { type: 'string', description: 'Transfer destination' },
        type: { type: 'string', enum: ['blind', 'peer'], description: 'Transfer type (default: blind)' },
      },
      required: ['domain', 'userId', 'callId', 'to'],
    },
  },
  {
    name: 'reject_call',
    description: 'Reject an incoming call',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        callId: { type: 'string', description: 'Call ID to reject' },
      },
      required: ['domain', 'userId', 'callId'],
    },
  },
  {
    name: 'report_active_calls',
    description: 'Report active calls system-wide',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'list_active_calls': {
      const result = args.userId
        ? await client.listUserActiveCalls(args.domain, args.userId)
        : await client.listActiveCalls(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved active calls' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'count_active_calls': {
      const result = await client.countActiveCalls(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Counted active calls' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_active_call': {
      const result = await client.getActiveCall(args.domain, args.userId, args.callId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved call ${args.callId}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'make_call': {
      const result = await client.makeCall(args.domain, args.userId, { to: args.to, from: args.from });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Call initiated' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'disconnect_call': {
      const result = await client.disconnectCall(args.domain, args.userId, args.callId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Call disconnected' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'answer_call': {
      const result = await client.answerCall(args.domain, args.userId, args.callId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Call answered' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'hold_call': {
      const result = await client.holdCall(args.domain, args.userId, args.callId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Call placed on hold' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'unhold_call': {
      const result = await client.unholdCall(args.domain, args.userId, args.callId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Call taken off hold' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'transfer_call': {
      const result = args.type === 'peer'
        ? await client.transferCallPeer(args.domain, args.userId, args.callId, args.to)
        : await client.transferCall(args.domain, args.userId, args.callId, args.to);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Call transferred' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'reject_call': {
      const result = await client.rejectCall(args.domain, args.userId, args.callId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Call rejected' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'report_active_calls': {
      const result = await client.reportActiveCalls();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Active calls report generated' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
