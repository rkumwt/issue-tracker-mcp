/**
 * LoggingTransport wraps the SERVER side of an in-memory client ↔ server pair,
 * exactly like stdio.ts and httpApp.ts wrap their real transports.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoggingTransport } from '../../src/lib/loggingTransport.js';
import { createServer } from '../../src/server.js';
import { createTestContext, type TestContext } from '../helpers.js';

let ctx: TestContext;
let client: Client;

beforeEach(async () => {
  ctx = createTestContext();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let tick = 0;
  const fakeClock = () => (tick += 5); // every reading is 5 ms later
  const server = createServer({ repo: ctx.repo, now: ctx.now, logger: ctx.logger });
  client = new Client({ name: 'test', version: '1' });
  await Promise.all([
    server.connect(new LoggingTransport(serverTransport, ctx.logger, fakeClock)),
    client.connect(clientTransport),
  ]);
  ctx.logs.length = 0; // ignore the initialize handshake
});

afterEach(async () => {
  await client.close();
  await ctx.repo.close();
});

const toolCalls = () => ctx.logs.filter((e) => e.event === 'tool_call');

describe('LoggingTransport', () => {
  it('logs a successful tool call with name, duration and outcome', async () => {
    await client.callTool({
      name: 'create_issue',
      arguments: { title: 'Secret project Falcon', description: 'd', priority: 'low' },
    });

    expect(toolCalls()).toEqual([
      expect.objectContaining({
        level: 'info',
        msg: 'tool call',
        method: 'tools/call',
        tool: 'create_issue',
        outcome: 'success',
        durationMs: 5,
      }),
    ]);
  });

  it('never logs tool arguments or results', async () => {
    await client.callTool({
      name: 'create_issue',
      arguments: { title: 'Secret project Falcon', description: 'd', priority: 'low' },
    });
    expect(JSON.stringify(ctx.logs)).not.toContain('Falcon');
  });

  it('logs domain errors with the error code from runTool', async () => {
    await client.callTool({ name: 'get_issue', arguments: { id: 'iss_000000000000' } });
    expect(toolCalls()[0]).toMatchObject({
      level: 'warn',
      outcome: 'tool_error',
      errorCode: 'NOT_FOUND',
    });
  });

  it('also logs calls the SDK rejects before the handler runs', async () => {
    await client.callTool({ name: 'create_issue', arguments: { title: '' } });
    expect(toolCalls()[0]).toMatchObject({
      tool: 'create_issue',
      outcome: 'tool_error',
      errorCode: 'INVALID_INPUT',
    });
  });

  it('logs non-tool requests at debug level', async () => {
    await client.listTools();
    expect(ctx.logs).toEqual([
      expect.objectContaining({
        level: 'debug',
        event: 'mcp_request',
        method: 'tools/list',
        outcome: 'success',
      }),
    ]);
  });

  it('delegates session id, protocol version, errors and close to the wrapped transport', async () => {
    const calls: string[] = [];
    const inner = {
      sessionId: 'session-1',
      start: async () => {
        calls.push('start');
      },
      send: async () => {
        calls.push('send');
      },
      close: async () => {
        calls.push('close');
      },
      setProtocolVersion: (v: string) => calls.push(`version:${v}`),
    } as Transport;
    const wrapped = new LoggingTransport(inner, ctx.logger);
    const errors: Error[] = [];
    wrapped.onerror = (e) => errors.push(e);

    await wrapped.start();
    wrapped.setProtocolVersion('2025-06-18');
    inner.onerror?.(new Error('boom'));
    await wrapped.close();

    expect(wrapped.sessionId).toBe('session-1');
    expect(calls).toEqual(['start', 'version:2025-06-18', 'close']);
    expect(errors.map((e) => e.message)).toEqual(['boom']);
  });

  it('logs JSON-RPC errors (e.g. unknown resource)', async () => {
    await expect(client.readResource({ uri: 'issues://nope' })).rejects.toThrow();
    expect(ctx.logs[0]).toMatchObject({
      level: 'warn',
      method: 'resources/read',
      outcome: 'rpc_error',
      errorCode: expect.stringMatching(/^RPC_-?\d+$/) as string,
    });
  });
});
