import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
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
import type { FieldClass, FieldRule, OutputDeclaration } from '../governance/types.js';

const UNAMBIGUOUS_SECRET_NAMES: Record<string, true> = {
  'device-sip-registration-password': true,
  'device-provisioning-password': true,
  'voicemail-login-pin': true,
  'email-send-smtp-password': true,
  smtp_pwd: true,
  client_secret: true,
  'client-secret': true,
  password: true,
  passcode: true,
  pin: true,
  secret: true,
  mfa: true,
  subscriber_pin: true,
  pwd_hash: true,
  pwd: true,
  auth_pass: true,
  authentication_key: true,
  'connection-sip-registration-password': true,
  'global-one-time-pass': true,
  'meeting-passcode': true,
  leader_pin: true,
  speaker_pin: true,
  participants_pin: true,
  SipSipAuthKey: true,
  access_token: true,
  refresh_token: true,
  data_token: true,
  idtoken: true,
  api_key: true,
  'api-key': true,
  auth_token: true,
  'auth-token': true,
};

function pathMatches(rulePath: string, currentPath: string): boolean {
  if (rulePath === currentPath) return true;
  if (!rulePath || !currentPath) return false;

  const ruleSegments = rulePath.split('.');
  const currentSegments = currentPath.split('.');

  if (ruleSegments.length !== currentSegments.length) return false;
  if (ruleSegments[0] === '*' || ruleSegments[0] === '**') return false;

  for (let i = 0; i < ruleSegments.length; i++) {
    const r = ruleSegments[i];
    const c = currentSegments[i];
    if (r === '*' || r === c) continue;
    return false;
  }
  return true;
}

function pathMatchesRule(rulePath: string, currentPath: string): boolean {
  if (pathMatches(rulePath, currentPath)) return true;
  if (!currentPath && (rulePath === 'data' || rulePath === '')) return true;
  if (rulePath === 'data[]' && (currentPath === '[]' || currentPath === 'data[]')) return true;
  if (rulePath.startsWith('data.') && pathMatches(rulePath, `data.${currentPath}`)) return true;
  if (rulePath.startsWith('data[]') && pathMatches(rulePath, `data${currentPath}`)) return true;
  return false;
}

function isContainerPath(rules: readonly FieldRule[], path: string): boolean {
  const prefixDot = `${path}.`;
  const prefixArray = `${path}[]`;
  const dataPrefixDot = `data.${path}.`;
  const dataPrefixArray = `data.${path}[]`;

  for (const rule of rules) {
    if (rule.path === path) return true;
    if (rule.path.startsWith(prefixDot) || rule.path.startsWith(prefixArray)) return true;
    if (rule.path.startsWith(dataPrefixDot) || rule.path.startsWith(dataPrefixArray)) return true;
    if (path === 'data' && (rule.path.startsWith('data.') || rule.path.startsWith('data[]'))) {
      return true;
    }
  }
  return false;
}

function findResourceForPath(
  rules: readonly FieldRule[] | undefined,
  path: string,
): string | undefined {
  if (!rules) return undefined;
  for (const rule of rules) {
    if ('resource' in rule && pathMatchesRule(rule.path, path)) {
      return rule.resource;
    }
  }
  return undefined;
}

export function findUndeclaredPaths(
  payload: unknown,
  output?: OutputDeclaration,
  nsResourceFields: Record<string, Record<string, FieldClass>> = NS_RESOURCE_FIELDS,
): string[] {
  const rules = output?.rules ?? [];
  for (const rule of rules) {
    const firstSegment = rule.path.split('.')[0];
    if (
      firstSegment === '*' ||
      firstSegment === '**' ||
      rule.path === '' ||
      rule.path === '*' ||
      rule.path === '**' ||
      rule.path.startsWith('*.') ||
      rule.path.startsWith('**')
    ) {
      throw new Error(`Wildcard root declarations are not permitted: '${rule.path}'`);
    }
  }
  const undeclared: string[] = [];

  function walk(val: unknown, currentPath: string, activeResource?: string): void {
    if (val === null || val === undefined || typeof val !== 'object') return;

    if (Array.isArray(val)) {
      const itemPath = currentPath ? `${currentPath}[]` : '[]';
      const itemResource =
        findResourceForPath(rules, itemPath) ??
        (currentPath ? findResourceForPath(rules, currentPath) : undefined) ??
        activeResource;

      for (const item of val) {
        walk(item, itemPath, itemResource);
      }
      return;
    }

    const obj = val as Record<string, unknown>;
    const objResource =
      (currentPath ? findResourceForPath(rules, currentPath) : undefined) ?? activeResource;

    for (const [key, propVal] of Object.entries(obj)) {
      const propPath = currentPath ? `${currentPath}.${key}` : key;
      if (UNAMBIGUOUS_SECRET_NAMES[key]) continue;

      let ruleMatched = false;
      for (const rule of rules) {
        if ('field' in rule && pathMatchesRule(rule.path, propPath)) {
          ruleMatched = true;
          break;
        }
      }
      if (ruleMatched) continue;

      if (objResource && nsResourceFields[objResource]?.[key]) continue;

      if (findResourceForPath(rules, propPath) || isContainerPath(rules, propPath)) {
        const childResource = findResourceForPath(rules, propPath) ?? objResource;
        walk(propVal, propPath, childResource);
        continue;
      }

      undeclared.push(propPath);
    }
  }

  walk(payload, '');
  return undeclared;
}

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
    const metaTools = buildMetaTools(new Map(), async () => ({}));
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
    const fieldDef = NS_RESOURCE_FIELDS.Messagesession?.['messagesession-last-message'];
    expect(fieldDef).toBeDefined();
    expect(fieldDef).toEqual({
      class: 'content',
      kind: 'sms_text',
      media: 'text',
    });

    const tool = CURATED_CATALOG.find((t) => t.schema.name === 'list_message_sessions');
    expect(tool).toBeDefined();
    const hasSessionRule = tool?.output.rules.some(
      (r) => 'resource' in r && r.resource === 'Messagesession',
    );
    expect(hasSessionRule).toBe(true);
  });

  it('my_devices drops device-sip-registration-password through scrubSecrets', async () => {
    const payload = {
      success: true,
      data: [
        {
          device: 'sip-device-1',
          'device-sip-registration-password': 'plaintext-password-123',
          'device-provisioning-password': 'prov-pass-456',
          'device-models-model': 'VVX 450',
          'device-sip-registration-state': 'registered',
        },
      ],
    };

    const tool = CURATED_CATALOG.find((t) => t.schema.name === 'my_devices');
    expect(tool).toBeDefined();

    const { scrubbed, count } = scrubSecrets(payload, tool?.output);
    expect(count).toBe(2);

    const scrubbedJson = JSON.stringify(scrubbed);
    expect(scrubbedJson).not.toContain('plaintext-password-123');
    expect(scrubbedJson).not.toContain('prov-pass-456');

    const firstDevice = (scrubbed as typeof payload).data[0];
    expect(firstDevice.device).toBe('sip-device-1');
    expect(firstDevice['device-models-model']).toBe('VVX 450');
    expect(firstDevice['device-sip-registration-state']).toBe('registered');
  });

  it('find_device drops password fields through scrubSecrets', async () => {
    const payload = {
      success: true,
      data: [
        {
          device: 'phone-mac-1',
          mac: '0004f2112233',
          'device-sip-registration-password': 'sip-secret',
          'device-provisioning-password': 'prov-secret',
          'global-one-time-pass': 'otp-secret',
          user: '1001',
          domain: 'test.domain',
        },
      ],
    };

    const tool = CURATED_CATALOG.find((t) => t.schema.name === 'find_device');
    expect(tool).toBeDefined();

    const { scrubbed, count } = scrubSecrets(payload, tool?.output);
    expect(count).toBe(3);

    const scrubbedJson = JSON.stringify(scrubbed);
    expect(scrubbedJson).not.toContain('sip-secret');
    expect(scrubbedJson).not.toContain('prov-secret');
    expect(scrubbedJson).not.toContain('otp-secret');
  });

  it('scrubSecrets removes secret fields at any depth without leaking values', () => {
    const deepPayload = {
      items: [
        {
          credentials: {
            password: 'secret-password-1234',
            smtp: {
              'email-send-smtp-password': 'smtp-pass-value',
            },
          },
          connections: [
            {
              'connection-sip-registration-password': 'sip-pass-value',
              name: 'trunk-1',
            },
          ],
          client_secret: 'oauth-client-secret-value',
          okItem: true,
        },
      ],
      ok: true,
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

    const nonSecretPayload = {
      success: true,
      data: {
        'language-token': 'en_US',
        'directory-name-number-dtmf-mapping': 764,
        'unassigned-key-press': '1',
        generic_pair: { key: 'status', value: 'active' },
        // A setting about a credential is not one (generator excludes -enabled the same way).
        'meeting-join-require-passcode-enabled': 'yes',
      },
    };
    const { scrubbed: scrubbedNonSecret, count: nonSecretCount } = scrubSecrets(nonSecretPayload);
    expect(nonSecretCount).toBe(0);
    expect((scrubbedNonSecret as typeof nonSecretPayload).data).toEqual(nonSecretPayload.data);
  });

  it('output declaration gate fails when undeclared paths exist', () => {
    const undeclaredPayload = {
      success: true,
      random_undeclared_key: 'value',
      data: [{ user: '1011', secret_unexposed_path: 42 }],
    };
    const declaration: OutputDeclaration = {
      rules: [{ path: 'success', field: { class: 'metadata' } }, { path: 'data[]', resource: 'User' }],
    };
    const undeclared = findUndeclaredPaths(undeclaredPayload, declaration);
    expect(undeclared).toContain('random_undeclared_key');
    expect(undeclared).toContain('data[].secret_unexposed_path');
  });

  it('rejects wildcard root declarations in output declaration gate', () => {
    const payload = { success: true, secret_field: 'leak' };
    expect(() =>
      findUndeclaredPaths(payload, {
        rules: [{ path: '*', field: { class: 'metadata' } }],
      }),
    ).toThrow(/wildcard root/i);

    expect(() =>
      findUndeclaredPaths(payload, {
        rules: [{ path: '*.*', field: { class: 'metadata' } }],
      }),
    ).toThrow(/wildcard root/i);
  });

  it('scrubSecrets drops credential-shaped keys regardless of value type', () => {
    const payload = {
      user: '1011',
      pin: 1234,
      passcode: 9876,
      'voicemail-login-pin': 5555,
      secret: { key: 'val', hash: 'xyz' },
      token: { access_token: 'tok-123', expires_in: 3600 },
      nested: {
        pin: 4321,
        secret: { inner: 'val' },
      },
    };
    const { scrubbed, count } = scrubSecrets(payload);
    expect(count).toBeGreaterThanOrEqual(6);
    const rec = scrubbed as Record<string, unknown>;
    expect(rec.user).toBe('1011');
    expect(rec.pin).toBeUndefined();
    expect(rec.passcode).toBeUndefined();
    expect(rec['voicemail-login-pin']).toBeUndefined();
    expect(rec.secret).toBeUndefined();
    expect(rec.token).toBeUndefined();
    const nested = rec.nested as Record<string, unknown>;
    expect(nested.pin).toBeUndefined();
    expect(nested.secret).toBeUndefined();
  });

  it('findUndeclaredPaths reports missing fields when tool output declaration is missing rules', () => {
    const payload = {
      success: true,
      data: [
        {
          domain: 's',
          description: 's',
        },
      ],
    };
    const emptyOutput = { rules: [] };
    const undeclared = findUndeclaredPaths(payload, emptyOutput);
    expect(undeclared.length).toBeGreaterThan(0);
    expect(undeclared).toContain('data');
    expect(undeclared).toContain('success');
  });

  it('every live read tool fixture has zero undeclared paths across all personas', () => {
    const toolsMap = new Map(CURATED_CATALOG.map((t) => [t.schema.name, t]));
    const liveDir = resolve('src/__tests__/fixtures/live');
    const files = readdirSync(liveDir).filter((f) => f.endsWith('.json'));

    expect(files.length).toBe(69);

    const failures: Record<string, string[]> = {};
    for (const file of files) {
      const toolName = file.split('.')[0];
      const tool = toolsMap.get(toolName);
      expect(tool, `Tool ${toolName} for fixture ${file} must exist in catalog`).toBeDefined();
      const payload = JSON.parse(readFileSync(resolve(liveDir, file), 'utf8'));
      const gaps = findUndeclaredPaths(payload, tool!.output);
      if (gaps.length > 0) {
        failures[file] = gaps;
      }
    }

    expect(failures).toEqual({});
  });

  it('every write and workflow tool branch has zero undeclared paths with stubbed responses', () => {
    const toolsMap = new Map(CURATED_CATALOG.map((t) => [t.schema.name, t]));

    const stubbedChecks: Array<{
      tool: string;
      branch: string;
      payload: unknown;
    }> = [
        // schedule_forwarding: time-bounded success
        {
          tool: 'schedule_forwarding',
          branch: 'time-bounded success',
          payload: {
            ok: true,
            timeframe: 'Forwarding 20261015-20261016',
            window: { from: '20261015 0000', until: '20261016 2359' },
            destination: '1011',
            steps: [
              { step: 'create time-frame', ok: true },
              { step: 'forward to 1011', ok: true },
            ],
            note: 'reusable',
          },
        },
        // schedule_forwarding: time-frame failure
        {
          tool: 'schedule_forwarding',
          branch: 'time-frame creation failed',
          payload: {
            ok: false,
            steps: [{ step: 'create time-frame', ok: false, error: 'Name collision' }],
            note: 'Time-frame creation failed',
          },
        },
        // schedule_forwarding: standing rule
        {
          tool: 'schedule_forwarding',
          branch: 'standing rule success',
          payload: {
            ok: true,
            timeframe: 'Default',
            destination: '1011',
            result: { ok: true, data: { 'time-frame': 'Default', enabled: 'yes' } },
          },
        },
        // update_my_answer_rule: success and error
        {
          tool: 'update_my_answer_rule',
          branch: 'success',
          payload: {
            success: true,
            data: { 'time-frame': 'Default', enabled: 'yes' },
          },
        },
        {
          tool: 'update_my_answer_rule',
          branch: 'error',
          payload: {
            success: false,
            error: '404 Not Found',
          },
        },
        // forward_voicemail: success and error
        {
          tool: 'forward_voicemail',
          branch: 'success',
          payload: {
            success: true,
            data: { filename: 'vm-1.wav', domain: 'dom', user: '1011' },
          },
        },
        {
          tool: 'forward_voicemail',
          branch: 'error',
          payload: {
            success: false,
            error: 'User not found',
          },
        },
        // send_message: chat & sms & error
        {
          tool: 'send_message',
          branch: 'session send success',
          payload: {
            success: true,
            data: { id: 'm-1', text: 'hello' },
          },
        },
        {
          tool: 'send_message',
          branch: 'error',
          payload: {
            success: false,
            error: 'Failed to send',
          },
        },
        // place_call: success and error
        {
          tool: 'place_call',
          branch: 'originate success',
          payload: {
            success: true,
            data: { 'call-session-id': 'c-101' },
          },
        },
        {
          tool: 'place_call',
          branch: 'error',
          payload: {
            success: false,
            error: 'Device not registered',
          },
        },
        // find_and_call: single match, multiple matches, error
        {
          tool: 'find_and_call',
          branch: 'single match dialed',
          payload: {
            ok: true,
            query: 'Alice',
            dialed: '1002',
            match: { source: 'user', extension: '1002', record: { user: '1002', 'name-first-name': 'Alice' } },
            call: { ok: true, data: { 'call-session-id': 'c-102' } },
          },
        },
        {
          tool: 'find_and_call',
          branch: 'multiple matches confirm=false',
          payload: {
            ok: false,
            query: '10',
            matches: [
              { source: 'user', extension: '1001', record: { user: '1001' } },
              { source: 'user', extension: '1002', record: { user: '1002' } },
            ],
            note: 'Multiple matches',
          },
        },
        // transfer_call: success and error
        {
          tool: 'transfer_call',
          branch: 'blind transfer success',
          payload: {
            success: true,
            data: { 'call-session-id': 'c-101' },
          },
        },
        {
          tool: 'transfer_call',
          branch: 'attended transfer success',
          payload: {
            success: true,
            data: { 'call-session-id': 'c-101' },
          },
        },
        {
          tool: 'transfer_call',
          branch: 'error',
          payload: {
            success: false,
            error: 'Call not found',
          },
        },
        // end_call: success and error
        {
          tool: 'end_call',
          branch: 'disconnect success',
          payload: {
            success: true,
            data: { 'call-session-id': 'c-101' },
          },
        },
        {
          tool: 'end_call',
          branch: 'error',
          payload: {
            success: false,
            error: 'Call not active',
          },
        },
        // switch_queue: success, logout failed, login failed
        {
          tool: 'switch_queue',
          branch: 'success',
          payload: {
            ok: true,
            from: '1001',
            to: '1002',
            agent: '1011',
            logout: { ok: true, data: { 'callqueue-agent-id': '1011@dom' } },
            login: { ok: true, data: { 'callqueue-agent-id': '1011@dom' } },
          },
        },
        {
          tool: 'switch_queue',
          branch: 'logout failed',
          payload: {
            ok: false,
            step: 'logout',
            from: '1001',
            to: '1002',
            agent: '1011',
            logout: { ok: false, error: 'Queue not found' },
            note: 'logout failed',
          },
        },
        // provision_user: success, failure, warnings
        {
          tool: 'provision_user',
          branch: 'success',
          payload: {
            ok: true,
            user: '1020@dom',
            steps: [
              { step: 'create user', ok: true, detail: { user: '1020', domain: 'dom' } },
              { step: 'create device', ok: true, detail: { device: '1020a' } },
              { step: 'assign phone number', ok: true, detail: { phonenumber: '5551234567' } },
            ],
            user_record: { user: '1020', domain: 'dom', 'name-first-name': 'New' },
            still_unconfigured: [],
          },
        },
        {
          tool: 'provision_user',
          branch: 'user creation failed',
          payload: {
            ok: false,
            user: '1020@dom',
            steps: [{ step: 'create user', ok: false, error: 'User already exists' }],
            note: 'User creation failed',
          },
        },
        // deprovision_user: dry_run and execute
        {
          tool: 'deprovision_user',
          branch: 'dry_run',
          payload: {
            dry_run: true,
            plan: {
              user: '1020@dom',
              deletes_user: true,
              cascaded_by_netsapiens: ['devices', 'contacts'],
              phone_numbers_to_release: ['5551234567'],
              queue_memberships_to_remove: [{ queue: '1099', agent_id: '1020@dom' }],
            },
          },
        },
        {
          tool: 'deprovision_user',
          branch: 'execute',
          payload: {
            ok: true,
            user: '1020@dom',
            steps: [{ step: 'delete user 1020@dom', ok: true }],
            cascaded_by_netsapiens: ['devices'],
            inventory_warnings: [],
          },
        },
        // provision_call_queue: success and failure
        {
          tool: 'provision_call_queue',
          branch: 'success',
          payload: {
            ok: true,
            callqueue: 'support@dom',
            agents_added: ['1001@dom'],
            steps: [{ step: 'create queue support', ok: true, detail: { callqueue: 'support', domain: 'dom' } }],
            still_unconfigured: [],
          },
        },
        {
          tool: 'provision_call_queue',
          branch: 'failure',
          payload: {
            ok: false,
            callqueue: 'support@dom',
            steps: [{ step: 'create queue support', ok: false, error: 'Queue exists' }],
            note: 'Queue creation failed',
          },
        },
        // deprovision_call_queue: dry_run and execute
        {
          tool: 'deprovision_call_queue',
          branch: 'dry_run',
          payload: {
            dry_run: true,
            plan: {
              callqueue: 'support@dom',
              deletes_queue: true,
              agents_to_remove: ['1001@dom'],
              phone_numbers_to_release: ['5551234567'],
            },
          },
        },
        {
          tool: 'deprovision_call_queue',
          branch: 'execute',
          payload: {
            ok: true,
            callqueue: 'support@dom',
            steps: [{ step: 'delete queue support', ok: true }],
            inventory_warnings: [],
          },
        },
        // set_hold_message: success and failure
        {
          tool: 'set_hold_message',
          branch: 'success',
          payload: {
            ok: true,
            scope: 'dom',
            action: 'added a new hold message',
            filename: 'hold.wav',
            result: { ok: true, data: { file: 'hold.wav' } },
          },
        },
        {
          tool: 'set_hold_message',
          branch: 'failure',
          payload: {
            ok: false,
            scope: 'dom',
            action: 'added a new hold message',
            filename: 'hold.wav',
            result: { ok: false, error: 'Upload failed' },
          },
        },
        // agent_login and agent_logout
        {
          tool: 'agent_login',
          branch: 'success',
          payload: {
            success: true,
            data: { 'callqueue-agent-id': '1011@dom' },
          },
        },
        {
          tool: 'agent_logout',
          branch: 'success',
          payload: {
            success: true,
            data: { 'callqueue-agent-id': '1011@dom' },
          },
        },
        {
          tool: 'agent_login',
          branch: 'refusal',
          payload: {
            success: false,
            error: 'Blake Example (2001) is not an agent in the Appointments queue (2090), so nothing was changed. Its agents are Casey Example (2006) and Avery Example (2007).',
          },
        },
        {
          tool: 'agent_logout',
          branch: 'refusal',
          payload: {
            success: false,
            error: 'Blake Example (2001) is not an agent in the Appointments queue (2090), so nothing was changed. Its agents are Casey Example (2006) and Avery Example (2007).',
          },
        },
        {
          tool: 'agent_login',
          branch: 'readback_success',
          payload: {
            success: true,
            data: { 'callqueue-agent-id': '2007@ExampleLab', 'callqueue-agent-availability-type': 'automatic' },
            note: 'Avery Example is logged in to the Appointments queue (2090).',
          },
        },
        {
          tool: 'agent_logout',
          branch: 'readback_success',
          payload: {
            success: true,
            data: { 'callqueue-agent-id': '2007@ExampleLab', 'callqueue-agent-availability-type': 'manual' },
            note: 'Avery Example is logged out of the Appointments queue (2090).',
          },
        },
        {
          tool: 'agent_login',
          branch: 'readback_pending',
          payload: {
            success: true,
            data: { 'callqueue-agent-id': '2007@ExampleLab' },
            note: 'NetSapiens accepted the change; the agent record does not show it yet.',
          },
        },
        {
          tool: 'agent_login',
          branch: 'all_queues',
          payload: {
            success: true,
            note: 'Avery Example is logged in to all queues.',
          },
        },
        {
          tool: 'switch_queue',
          branch: 'resolve failed',
          payload: {
            ok: false,
            step: 'resolve',
            from: '2090',
            to: '2099',
            agent: '2007@ExampleLab',
            note: 'Avery Example is not an agent in the Billing queue (2099), so nothing was changed.',
          },
        },
        // queue_status: live state success
        {
          tool: 'queue_status',
          branch: 'success with live callers, agents, and statistics',
          payload: {
            queue_id: '2090',
            queue: {
              callqueue: '2090',
              description: 'Appointments',
            },
            waiting: {
              ok: true,
              count: 3,
              longest_wait_seconds: 11,
              callers: [
                {
                  caller: 'Carol White',
                  queued_at: '2026-10-19 16:09:12',
                  wait_seconds: 11,
                },
                {
                  caller: 'Bob Jones',
                  queued_at: '2026-10-19 16:09:16',
                  wait_seconds: 7,
                },
                {
                  caller: 'Alice Smith',
                  queued_at: '2026-10-19 16:09:20',
                  wait_seconds: 3,
                },
              ],
            },
            agents: {
              ok: true,
              data: [
                {
                  'callqueue-agent-id': '2006@ExampleLab',
                  'name-full-name': 'Casey Example',
                  'callqueue-agent-availability-type': 'automatic',
                  'active-calls-total-current': 1,
                },
                {
                  'callqueue-agent-id': '2007@ExampleLab',
                  'name-full-name': 'Avery Example',
                  'callqueue-agent-availability-type': 'manual',
                  'active-calls-total-current': 0,
                },
              ],
            },
            statistics: {
              ok: true,
              start: '2026-10-18 16:09:20',
              end: '2026-10-19 16:09:20',
              data: [],
            },
          },
        },
        // queue_status: partial failure (waiting 403)
        {
          tool: 'queue_status',
          branch: 'partial failure: waiting 403',
          payload: {
            queue_id: '2090',
            queue: null,
            waiting: {
              ok: false,
              error: '403 Forbidden',
            },
            agents: {
              ok: true,
              data: [],
            },
            statistics: {
              ok: true,
              start: '2026-10-18 16:09:20',
              end: '2026-10-19 16:09:20',
              data: [],
            },
          },
        },
        // queue_status: partial failure (agents failed)
        {
          tool: 'queue_status',
          branch: 'partial failure: agents failed',
          payload: {
            queue_id: '2090',
            queue: {
              callqueue: '2090',
              description: 'Appointments',
            },
            waiting: {
              ok: true,
              count: 0,
              longest_wait_seconds: 0,
              callers: [],
            },
            agents: {
              ok: false,
              error: '500 Server Error',
            },
            statistics: {
              ok: false,
              error: '500 Server Error',
            },
          },
        },
        // queue_status: all fail
        {
          tool: 'queue_status',
          branch: 'all fail',
          payload: {
            success: false,
            error: '404 Queue not found',
          },
        },
        // voicemail_inbox_summary
        {
          tool: 'voicemail_inbox_summary',
          branch: 'success with transcripts',
          payload: {
            folder: 'new',
            count: 1,
            voicemails: [
              {
                from: 'Alice Smith <15551112222>',
                at: '2026-10-19 12:00:00',
                duration: 30,
                transcript: 'Hey it is Alice, please call me back.',
                transcription_status: 'finished',
                id: 'vm-20261019120000-call1.wav',
              },
            ],
          },
        },
        {
          tool: 'voicemail_inbox_summary',
          branch: 'success unavailable transcript',
          payload: {
            folder: 'new',
            count: 1,
            voicemails: [
              {
                from: '15553334444',
                at: '2026-10-19 12:30:00',
                duration: 12,
                transcription_status: 'unavailable',
                id: 'vm-20261019123000-call2.wav',
              },
            ],
          },
        },
      ];

    for (const check of stubbedChecks) {
      const tool = toolsMap.get(check.tool);
      expect(tool, `Tool ${check.tool} must exist in catalog`).toBeDefined();
      const gaps = findUndeclaredPaths(check.payload, tool!.output);
      expect(
        gaps,
        `Tool ${check.tool} (${check.branch}) had undeclared paths: ${gaps.join(', ')}`,
      ).toEqual([]);
    }
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
