import { NetSapiensClient } from '../netsapiens-client.js';

export const toolDefinitions = [
  {
    name: 'list_holidays',
    description: 'List holidays by country, region, and year',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['countries', 'regions', 'holidays'], description: 'What to list' },
        country: { type: 'string', description: 'Country code (for holidays)' },
        region: { type: 'string', description: 'Region code (optional, for regional holidays)' },
        year: { type: 'string', description: 'Year (for holidays)' },
      },
      required: ['type'],
    },
  },
  {
    name: 'list_departments',
    description: 'List departments in a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'list_presence',
    description: 'List presence status in a domain or department',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        department: { type: 'string', description: 'Department name (optional)' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'list_dashboards',
    description: 'List dashboards for a user',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
      },
      required: ['domain', 'userId'],
    },
  },
  {
    name: 'list_charts',
    description: 'List charts for a dashboard',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        dashboardId: { type: 'string', description: 'Dashboard ID' },
      },
      required: ['domain', 'dashboardId'],
    },
  },
  {
    name: 'manage_domain_schedules',
    description: 'Get CDR schedule counts for a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        scheduleName: { type: 'string', description: 'Schedule name (optional, for specific schedule count)' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'send_email',
    description: 'Send an email using a template',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        data: { type: 'object', description: 'Email data (template, recipients, variables)' },
      },
      required: ['domain', 'userId', 'data'],
    },
  },
  {
    name: 'verify_email',
    description: 'Verify an email address with a token',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        token: { type: 'string', description: 'Verification token' },
      },
      required: ['domain', 'userId', 'token'],
    },
  },
  {
    name: 'synthesize_voice',
    description: 'Synthesize voice from text (text-to-speech)',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        text: { type: 'string', description: 'Text to synthesize' },
        voice: { type: 'string', description: 'Voice to use (optional)' },
        language: { type: 'string', description: 'Language code (optional)' },
      },
      required: ['domain', 'userId', 'text'],
    },
  },
  {
    name: 'get_available_voices',
    description: 'Get available TTS voices for a language',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        userId: { type: 'string', description: 'User ID' },
        language: { type: 'string', description: 'Language code' },
      },
      required: ['domain', 'userId', 'language'],
    },
  },
  {
    name: 'list_domain_devices',
    description: 'List or count devices in a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        action: { type: 'string', enum: ['list', 'count', 'count_device'], description: 'Action to perform' },
        device: { type: 'string', description: 'Device ID (for count_device)' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'list_domain_quotas',
    description: 'List or count quotas for a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
        action: { type: 'string', enum: ['list', 'count'], description: 'Action to perform' },
      },
      required: ['domain'],
    },
  },
];

export async function handleToolCall(client: NetSapiensClient, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'list_holidays': {
      let result;
      switch (args.type) {
        case 'countries': result = await client.listHolidayCountries(); break;
        case 'regions': result = await client.listHolidayRegions(); break;
        case 'holidays':
          result = args.region
            ? await client.getHolidaysByRegion(args.country, args.region, args.year)
            : await client.getHolidaysByCountry(args.country, args.year);
          break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown type: ${args.type}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Retrieved holiday data` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'list_departments': {
      const result = await client.listDepartments(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved departments' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'list_presence': {
      const result = args.department
        ? await client.listDepartmentPresence(args.domain, args.department)
        : await client.listDomainPresence(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved presence' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'list_dashboards': {
      const result = await client.listDashboards(args.domain, args.userId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved dashboards' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'list_charts': {
      const result = await client.listCharts(args.domain, args.dashboardId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved charts' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'manage_domain_schedules': {
      const result = args.scheduleName
        ? await client.countScheduleByName(args.domain, args.scheduleName)
        : await client.countDomainSchedules(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved schedule count' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'send_email': {
      const result = await client.sendEmail(args.domain, args.userId, args.data);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Email sent' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'verify_email': {
      const result = await client.verifyEmail(args.domain, args.userId, args.token);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Email verified' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'synthesize_voice': {
      const result = await client.synthesizeVoice(args.domain, args.userId, { text: args.text, voice: args.voice, language: args.language });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Voice synthesized' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'get_available_voices': {
      const result = await client.getAvailableVoices(args.domain, args.userId, args.language);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? 'Retrieved available voices' : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'list_domain_devices': {
      let result;
      const action = args.action || 'list';
      switch (action) {
        case 'list': result = await client.listDomainDevices(args.domain); break;
        case 'count': result = await client.countDomainDevices(args.domain); break;
        case 'count_device': result = await client.countDomainDevicesByDevice(args.domain, args.device); break;
        default: return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown action: ${action}` }, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Devices ${action} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    case 'list_domain_quotas': {
      const result = (args.action || 'list') === 'count'
        ? await client.countDomainQuotas(args.domain)
        : await client.listDomainQuotas(args.domain);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, message: result.success ? `Quotas ${args.action || 'list'} successful` : `Failed: ${result.error}`, data: result.data, error: result.error }, null, 2) }],
      };
    }
    default:
      return null;
  }
}
