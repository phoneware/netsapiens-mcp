import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'get_user_answer_rules',
    description: 'Get answer rules for a user',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User ID' },
        domain: { type: 'string', description: 'Domain name' },
      },
      required: ['userId', 'domain'],
    },
  },
  {
    name: 'get_user_answer_rule',
    description: 'Get specific answer rule for a user by timeframe',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User ID' },
        domain: { type: 'string', description: 'Domain name' },
        timeframe: { type: 'string', description: 'Timeframe for the answer rule' },
      },
      required: ['userId', 'domain', 'timeframe'],
    },
  },
  {
    name: 'create_answer_rule',
    description: 'Create a new answer rule for a user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        data: { type: 'object', description: 'Answer rule data including timeframe, forward destination, voicemail settings' },
      },
      required: ['domain', 'userId', 'data'],
    },
  },
  {
    name: 'update_answer_rule',
    description: 'Update an existing answer rule for a user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        timeframe: { type: 'string', description: 'Timeframe of the answer rule to update' },
        data: { type: 'object', description: 'Updated answer rule data' },
      },
      required: ['domain', 'userId', 'timeframe', 'data'],
    },
  },
  {
    name: 'delete_answer_rule',
    description: 'Delete an answer rule for a user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        timeframe: { type: 'string', description: 'Timeframe of the answer rule to delete' },
      },
      required: ['domain', 'userId', 'timeframe'],
    },
  },
  {
    name: 'reorder_answer_rules',
    description: 'Reorder answer rules for a user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        order: { type: 'array', items: { type: 'string' }, description: 'Ordered list of timeframe names' },
      },
      required: ['domain', 'userId', 'order'],
    },
  },
  {
    name: 'count_answer_rules',
    description: 'Count answer rules for a user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
      },
      required: ['domain', 'userId'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'get_user_answer_rules': {
      const result = await client.getUserAnswerRules(args.userId, args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved ${result.data?.length || 0} answer rules for user ${args.userId}@${args.domain}` : `Failed to get answer rules: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_user_answer_rule': {
      const result = await client.getUserAnswerRule(args.userId, args.domain, args.timeframe);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved answer rule for ${args.userId}@${args.domain} timeframe ${args.timeframe}` : `Failed to get answer rule: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'create_answer_rule': {
      const result = await client.createAnswerRule(args.domain, args.userId, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Answer rule created' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'update_answer_rule': {
      const result = await client.updateAnswerRule(args.domain, args.userId, args.timeframe, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Answer rule updated` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'delete_answer_rule': {
      const result = await client.deleteAnswerRule(args.domain, args.userId, args.timeframe);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Answer rule deleted` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'reorder_answer_rules': {
      const result = await client.reorderAnswerRules(args.domain, args.userId, args.order);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Answer rules reordered' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'count_answer_rules': {
      const result = await client.countAnswerRules(args.domain, args.userId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Counted answer rules' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
