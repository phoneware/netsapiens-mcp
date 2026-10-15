import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { negotiateProtocolVersion } from '../http/protocol-version.js';

async function bootTransport() {
  const app = express();
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    negotiateProtocolVersion(req);

    const server = new Server(
      { name: 'test-server', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'test_tool', description: 'test tool', inputSchema: { type: 'object' } }],
    }));

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address');
  }

  return {
    port: address.port,
    async toolsList(version?: string) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      };
      if (version) {
        headers['mcp-protocol-version'] = version;
      }

      const res = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      const text = await res.text();
      return {
        status: res.status,
        refusedForVersion: /Unsupported protocol version/.test(text),
        text,
      };
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('protocol version negotiation', () => {
  it('is still needed, because SDK does not support 2026-07-28', () => {
    expect((SUPPORTED_PROTOCOL_VERSIONS as readonly string[])).not.toContain('2026-07-28');
  });

  it('lets a request carrying an unsupported version through the real transport', async () => {
    const t = await bootTransport();
    try {
      const answered = await t.toolsList('2026-07-28');
      expect(answered.refusedForVersion).toBe(false);
      expect(answered.status).toBe(200);
      expect(answered.text).toContain('"tools"');
    } finally {
      await t.close();
    }
  });

  it('leaves a supported version alone, end to end', async () => {
    const t = await bootTransport();
    try {
      const answered = await t.toolsList(LATEST_PROTOCOL_VERSION);
      expect(answered.status).toBe(200);
      expect(answered.refusedForVersion).toBe(false);
    } finally {
      await t.close();
    }
  });

  it('leaves older unsupported versions like 2024-01-01 for SDK rejection', async () => {
    const t = await bootTransport();
    try {
      const answered = await t.toolsList('2024-01-01');
      expect(answered.status).toBe(400);
      expect(answered.refusedForVersion).toBe(true);
    } finally {
      await t.close();
    }
  });

  it('leaves malformed versions like garbage for SDK rejection', async () => {
    const t = await bootTransport();
    try {
      const answered = await t.toolsList('garbage');
      expect(answered.status).toBe(400);
      expect(answered.refusedForVersion).toBe(true);
    } finally {
      await t.close();
    }
  });
  it('leaves impossible calendar dates like 2026-02-31 for SDK rejection', async () => {
    const t = await bootTransport();
    try {
      const answered = await t.toolsList('2026-02-31');
      expect(answered.status).toBe(400);
      expect(answered.refusedForVersion).toBe(true);
    } finally {
      await t.close();
    }
  });


  it('leaves older or malformed headers untouched in negotiateProtocolVersion', () => {
    for (const invalid of ['2024-01-01', 'garbage', 'invalid-date', '2020-99-99', '2026-02-31', '2025-02-29', '2026-04-31', '2026-13-01', '2026-00-10']) {
      const req = {
        headers: { 'mcp-protocol-version': invalid } as NodeJS.Dict<string | string[]>,
        rawHeaders: ['MCP-Protocol-Version', invalid],
      };
      expect(negotiateProtocolVersion(req)).toBeUndefined();
      expect(req.headers['mcp-protocol-version']).toBe(invalid);
    }
  });

  it('leaves every version the SDK supports untouched, in both representations', () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      const req = {
        headers: { 'mcp-protocol-version': version } as NodeJS.Dict<string | string[]>,
        rawHeaders: ['MCP-Protocol-Version', version],
      };
      expect(negotiateProtocolVersion(req)).toBeUndefined();
      expect(req.headers['mcp-protocol-version']).toBe(version);
      expect(req.rawHeaders[1]).toBe(version);
    }
  });

  it('rewrites both header representations when unsupported version is passed', () => {
    const req = {
      headers: { 'mcp-protocol-version': '2026-07-28' } as NodeJS.Dict<string | string[]>,
      rawHeaders: ['Accept', 'application/json', 'MCP-Protocol-Version', '2026-07-28'],
    };
    expect(negotiateProtocolVersion(req)).toEqual({
      requested: '2026-07-28',
      negotiated: LATEST_PROTOCOL_VERSION,
    });
    expect(req.headers['mcp-protocol-version']).toBe(LATEST_PROTOCOL_VERSION);
    expect(req.rawHeaders[3]).toBe(LATEST_PROTOCOL_VERSION);
    expect(req.rawHeaders[1]).toBe('application/json');
  });

  it('leaves an absent header absent', () => {
    const req = { headers: {} as NodeJS.Dict<string | string[]>, rawHeaders: [] };
    expect(negotiateProtocolVersion(req)).toBeUndefined();
    expect('mcp-protocol-version' in req.headers).toBe(false);
  });
});
