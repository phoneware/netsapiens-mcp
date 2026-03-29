import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'get_recording',
    description: 'Get a specific recording by call ID at domain or user level',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID (optional, for user-level recordings)' },
        callId: { type: 'string', description: 'Call ID of the recording' },
      },
      required: ['domain', 'callId'],
    },
  },
  {
    name: 'get_transcription',
    description: 'Get transcription for a specific call',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        callId: { type: 'string', description: 'Call ID to get transcription for' },
      },
      required: ['domain', 'callId'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'get_recording': {
      const result = args.userId
        ? await client.getUserRecording(args.domain, args.userId, args.callId)
        : await client.getDomainRecording(args.domain, args.callId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved recording for call ${args.callId}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_transcription': {
      const result = await client.getTranscription(args.domain, args.callId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved transcription for call ${args.callId}` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
