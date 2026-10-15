import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { CURATED_CATALOG } from '../tools/curated/catalog.js';
import { WORKFLOW_TOOLS } from '../tools/curated/workflows.js';
import { buildMetaTools } from '../tools/curated/meta.js';
import { handleToolCall } from '../tools/index.js';
import { NS_RESOURCE_FIELDS } from '../governance/ns-fields.generated.js';
import { scrubSecrets } from '../governance/scrub.js';
import { logger } from '../utils/logger.js';
import type { CuratedTool } from '../tools/curated/types.js';

describe('Governance Declarations & Secret Scrubbing (L1b)', () => {
  it('every curated tool declares output and targets', () => {
    for (const tool of CURATED_CATALOG) {
      expect(
        tool.output,
        `Tool '${tool.schema.name}' must declare required 'output'`,
      ).toBeDefined();
      expect(
        Array.isArray(tool.output.rules),
        `Tool '${tool.schema.name}' output must have rules array`,
      ).toBe(true);
      expect(
        tool.output.rules.length,
        `Tool '${tool.schema.name}' output rules must be non-empty`,
      ).toBeGreaterThan(0);

      expect(
        tool.targets,
        `Tool '${tool.schema.name}' must declare required 'targets'`,
      ).toBeDefined();
      expect(
        typeof tool.targets,
        `Tool '${tool.schema.name}' targets must be an object`,
      ).toBe('object');
    }
  });

  it('every workflow tool declares output and targets', () => {
    for (const tool of WORKFLOW_TOOLS) {
      expect(
        tool.output,
        `Workflow tool '${tool.schema.name}' must declare required 'output'`,
      ).toBeDefined();
      expect(
        Array.isArray(tool.output.rules),
        `Workflow tool '${tool.schema.name}' output must have rules array`,
      ).toBe(true);
      expect(
        tool.output.rules.length,
        `Workflow tool '${tool.schema.name}' output rules must be non-empty`,
      ).toBeGreaterThan(0);
      expect(
        tool.targets,
        `Workflow tool '${tool.schema.name}' must declare required 'targets'`,
      ).toBeDefined();
    }
  });

  it('every meta tool declares output and targets', () => {
    const metaTools = buildMetaTools();
    for (const tool of metaTools) {
      expect(
        tool.output,
        `Meta tool '${tool.schema.name}' must declare required 'output'`,
      ).toBeDefined();
      expect(
        Array.isArray(tool.output.rules),
        `Meta tool '${tool.schema.name}' output must have rules array`,
      ).toBe(true);
      if (tool.schema.name === 'call_api') {
        // explicit, tested exception for the opaque escape hatch
        expect(tool.output.rules.length).toBe(0);
      } else {
        expect(
          tool.output.rules.length,
          `Meta tool '${tool.schema.name}' output rules must be non-empty`,
        ).toBeGreaterThan(0);
      }
      expect(
        tool.targets,
        `Meta tool '${tool.schema.name}' must declare required 'targets'`,
      ).toBeDefined();
    }
  });

  it('list_message_sessions classifies messagesession-last-message as sms_text', async () => {
    // 1. Verify resource table classification
    const fieldDef = NS_RESOURCE_FIELDS.Messagesession?.['messagesession-last-message'];
    expect(fieldDef).toBeDefined();
    expect(fieldDef).toEqual({
      class: 'content',
      kind: 'sms_text',
      media: 'text',
    });

    // 2. Verify tool declaration links to Messagesession resource
    const tool = CURATED_CATALOG.find((t) => t.schema.name === 'list_message_sessions');
    expect(tool).toBeDefined();
    const hasSessionRule = tool?.output.rules.some(
      (r) => 'resource' in r && r.resource === 'Messagesession',
    );
    expect(hasSessionRule).toBe(true);
  });

  it('my_devices drops device-sip-registration-password through scrubSecrets', async () => {
    const myDevicesTool = CURATED_CATALOG.find((t) => t.schema.name === 'my_devices');
    expect(myDevicesTool).toBeDefined();

    const mockDevice = {
      device: 'mac-001122334455',
      user: '1001',
      'device-sip-registration-password': 'super-secret-password-123',
      'device-provisioning-password': 'provision-secret-456',
      'device-sip-registration-state': 'registered',
      'device-sip-registration-user-agent': 'Yealink SIP-T46S',
    };

    const payload = {
      success: true,
      data: [mockDevice],
    };

    // 1. Direct scrubSecrets function test
    const { scrubbed, count } = scrubSecrets(payload, myDevicesTool?.output);
    expect(count).toBe(2);

    const scrubbedDevices = (scrubbed as { data: Array<Record<string, unknown>> }).data;
    expect(scrubbedDevices[0]).toBeDefined();
    expect(scrubbedDevices[0].device).toBe('mac-001122334455');
    expect(scrubbedDevices[0]['device-sip-registration-state']).toBe('registered');
    expect(scrubbedDevices[0]['device-sip-registration-password']).toBeUndefined();
    expect(scrubbedDevices[0]['device-provisioning-password']).toBeUndefined();

    // 2. Full handleToolCall flow test with logging
    const infoSpy = vi.spyOn(logger, 'info');
    const fakeClient = {
      request: vi.fn(async () => ({ success: true, data: [mockDevice] })),
    };

    try {
      const toolResult = (await handleToolCall(
        fakeClient as never,
        'my_devices',
        {},
        'user',
        '1001@acme.com',
      )) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(toolResult.content[0].text);
      expect(parsed.data[0]['device-sip-registration-password']).toBeUndefined();
      expect(parsed.data[0]['device-provisioning-password']).toBeUndefined();
      expect(parsed.data[0].device).toBe('mac-001122334455');

      // Assert log contains secretsScrubbed count and never password values
      const toolLogs = infoSpy.mock.calls.filter((call) => call[0] === 'Tool call');
      expect(toolLogs.length).toBe(1);
      const logContext = toolLogs[0][1];
      expect(logContext?.secretsScrubbed).toBe(2);

      const loggedString = JSON.stringify(toolLogs);
      expect(loggedString).not.toContain('super-secret-password-123');
      expect(loggedString).not.toContain('provision-secret-456');
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('scrubSecrets removes secret fields at any depth without leaking values', () => {
    const deepPayload = {
      level1: {
        normal: 'ok',
        'voicemail-login-pin': '1234',
        nestedArray: [
          {
            okItem: true,
            'email-send-smtp-password': 'smtp-pass-value',
            deeper: {
              'device-sip-registration-password': 'sip-pass-value',
              client_secret: 'oauth-client-secret-value',
            },
          },
        ],
      },
    };

    const { scrubbed, count } = scrubSecrets(deepPayload);
    expect(count).toBe(4);

    const json = JSON.stringify(scrubbed);
    expect(json).not.toContain('1234');
    expect(json).not.toContain('smtp-pass-value');
    expect(json).not.toContain('sip-pass-value');
    expect(json).not.toContain('oauth-client-secret-value');
    expect(json).toContain('ok');
    expect(json).toContain('okItem');
  });

  it('every field present in e2e fixtures is declared in NS_RESOURCE_FIELDS', () => {
    // ggrm-office-manager-e2e.mjs fixtures:
    // /domains/~/users/~: user-scope, user, domain -> User
    // /domains/~: domain, description -> Domain
    // /domains/~/users: user, name-first-name -> User
    // /domains/~/users/~/voicemails/(folder): filename, caller-id-number -> Voicemail
    // USER_290_CDRS / DOMAIN_CDRS: call-orig-call-id, core-server, call-start-datetime, call-disconnect-datetime, is-trace-expected -> CdrD
    // /sipflow: type, servers, data -> CallTrace

    const fixtureChecks: Array<{ resource: string; fields: string[] }> = [
      {
        resource: 'User',
        fields: ['user-scope', 'user', 'domain', 'name-first-name'],
      },
      {
        resource: 'Domain',
        fields: ['domain', 'description'],
      },
      {
        resource: 'Voicemail',
        fields: ['filename', 'caller-id-number', 'folder', 'datetime', 'duration'],
      },
      {
        resource: 'CdrD',
        fields: [
          'call-orig-call-id',
          'core-server',
          'call-start-datetime',
          'call-disconnect-datetime',
          'is-trace-expected',
        ],
      },
      {
        resource: 'CallTrace',
        fields: ['type', 'servers', 'data'],
      },
      {
        resource: 'Count',
        fields: ['total', 'total-duration'],
      },
    ];

    for (const { resource, fields } of fixtureChecks) {
      const resTable = NS_RESOURCE_FIELDS[resource];
      expect(resTable, `Resource '${resource}' must exist in NS_RESOURCE_FIELDS`).toBeDefined();
      for (const field of fields) {
        expect(
          resTable[field],
          `Field '${field}' on resource '${resource}' must be declared`,
        ).toBeDefined();
      }
    }
  });

  it('classifies JwtRequestSuccess.refresh and Chart.data_token as secrets', () => {
    expect(NS_RESOURCE_FIELDS.JwtRequestSuccess?.refresh).toEqual({ class: 'secret' });
    expect(NS_RESOURCE_FIELDS.Chart?.data_token).toEqual({ class: 'secret' });

    const jwtPayload = { token: 'jwt-access-token', refresh: 'jwt-refresh-token' };
    const { scrubbed: scrubbedJwt, count: jwtCount } = scrubSecrets(jwtPayload, {
      rules: [{ path: '', resource: 'JwtRequestSuccess' }],
    });
    expect(jwtCount).toBe(2);
    expect(scrubbedJwt).toEqual({});

    const chartPayload = {
      id: 1,
      name: 'CallVolumeChart',
      data_token: { access_token: 'secret-chart-token' },
    };
    const { scrubbed: scrubbedChart, count: chartCount } = scrubSecrets(chartPayload, {
      rules: [{ path: '', resource: 'Chart' }],
    });
    expect(chartCount).toBe(1);
    expect((scrubbedChart as Record<string, unknown>).data_token).toBeUndefined();
    expect((scrubbedChart as Record<string, unknown>).name).toBe('CallVolumeChart');
  });

  it('removes legacy smtp_pwd password as a secret', () => {
    expect(NS_RESOURCE_FIELDS.DomainLegacy?.smtp_pwd).toEqual({ class: 'secret' });

    const payload = {
      domain: 'legacy.domain',
      description: 'Legacy Domain',
      smtp_pwd: 'legacy-smtp-password',
    };
    const { scrubbed, count } = scrubSecrets(payload);
    expect(count).toBe(1);
    expect((scrubbed as Record<string, unknown>).smtp_pwd).toBeUndefined();
    expect((scrubbed as Record<string, unknown>).domain).toBe('legacy.domain');
  });

  it('removes legacy pwd password as a secret', () => {
    expect(NS_RESOURCE_FIELDS.AnswerruleLegacy?.pwd).toEqual({ class: 'secret' });

    const payload = {
      user: '1001',
      domain: 'test.com',
      time_frame: 'Default',
      pwd: 'legacy-answerrule-password',
      pwd_hash: 'hash123',
    };
    const { scrubbed, count } = scrubSecrets(payload);
    expect(count).toBe(2);
    expect((scrubbed as Record<string, unknown>).pwd).toBeUndefined();
    expect((scrubbed as Record<string, unknown>).pwd_hash).toBeUndefined();
    expect((scrubbed as Record<string, unknown>).time_frame).toBe('Default');
  });

  it('scrubs credential fields inside JSON-encoded strings', () => {
    const payload = {
      raw_json: JSON.stringify({
        device: 'mac-1',
        'device-sip-registration-password': 'secret-sip-pass',
        nested: {
          'voicemail-login-pin': '9999',
        },
      }),
      plain_text: 'This is just a regular string with { brackets }',
    };

    const { scrubbed, count } = scrubSecrets(payload);
    expect(count).toBe(2);

    const parsedRaw = JSON.parse((scrubbed as { raw_json: string }).raw_json);
    expect(parsedRaw.device).toBe('mac-1');
    expect(parsedRaw['device-sip-registration-password']).toBeUndefined();
    expect(parsedRaw.nested['voicemail-login-pin']).toBeUndefined();
    expect((scrubbed as { plain_text: string }).plain_text).toBe(
      'This is just a regular string with { brackets }',
    );
  });

  it('scrubs resource-specific secrets in generated tools and call_api without false positives', async () => {
    // 1. ApiKey.key via call_api / generated response
    const apiKeyPayload = {
      success: true,
      data: {
        'key-id': 'k-999',
        key: 'secret-api-key-val',
        description: 'Test API Key',
      },
    };
    const { scrubbed: scrubbedKey, count: keyCount } = scrubSecrets(apiKeyPayload);
    expect(keyCount).toBe(1);
    const keyData = (scrubbedKey as typeof apiKeyPayload).data;
    expect(keyData.key).toBeUndefined();
    expect(keyData['key-id']).toBe('k-999');
    expect(keyData.description).toBe('Test API Key');

    // 2. AccessToken via generated response
    const tokenPayload = {
      success: true,
      data: {
        access_token: 'secret-access-token-val',
        refresh_token: 'secret-refresh-token-val',
        token_type: 'Bearer',
      },
    };
    const { scrubbed: scrubbedToken, count: tokenCount } = scrubSecrets(tokenPayload);
    expect(tokenCount).toBe(2);
    const tokenData = (scrubbedToken as typeof tokenPayload).data;
    expect(tokenData.access_token).toBeUndefined();
    expect(tokenData.refresh_token).toBeUndefined();
    expect(tokenData.token_type).toBe('Bearer');

    // 3. No false positives on non-secret fields containing token, pin, or key
    const nonSecretPayload = {
      success: true,
      data: {
        'language-token': 'en_US',
        'directory-name-number-dtmf-mapping': 764,
        'unassigned-key-press': '1',
        generic_pair: { key: 'status', value: 'active' },
      },
    };
    const { scrubbed: scrubbedNonSecret, count: nonSecretCount } = scrubSecrets(nonSecretPayload);
    expect(nonSecretCount).toBe(0);
    expect((scrubbedNonSecret as typeof nonSecretPayload).data).toEqual(nonSecretPayload.data);
  });

  it('generate:governance output is deterministic', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(testDir, '../..');
    const generatedPath = resolve(testDir, '../governance/ns-fields.generated.ts');
    const before = readFileSync(generatedPath, 'utf8');

    execSync('npm run generate:governance', { cwd: repoRoot, stdio: 'pipe' });
    const after = readFileSync(generatedPath, 'utf8');
    expect(after).toBe(before);
  });
});
