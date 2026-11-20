/**
 * HTTP transport tests: the real Express app driven by supertest (no network
 * port is opened). Covers auth, limits, stateless MCP over HTTP and logging.
 */
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpApp, type HttpAppOptions } from '../../src/httpApp.js';
import { createTestContext, type TestContext } from '../helpers.js';

const API_KEY = 'test-key-0123456789abcdef0123456789abcdef';
// Streamable HTTP clients must accept both JSON and SSE.
const ACCEPT = 'application/json, text/event-stream';

let ctx: TestContext;

function makeApp(overrides: Partial<HttpAppOptions> = {}): Express {
  ctx = createTestContext();
  return createHttpApp({
    repo: ctx.repo,
    logger: ctx.logger,
    now: ctx.now,
    apiKey: API_KEY,
    rateLimitPerMinute: 1_000,
    maxBodyBytes: 10_240,
    ...overrides,
  });
}

let nextId = 1;
function rpc(app: Express, method: string, params: object = {}, key: string = API_KEY) {
  return request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${key}`)
    .set('Accept', ACCEPT)
    .send({ jsonrpc: '2.0', id: nextId++, method, params });
}

function callTool(app: Express, name: string, args: object) {
  return rpc(app, 'tools/call', { name, arguments: args });
}

/** Parse the JSON text a tool returned. */
function toolData(res: request.Response): Record<string, unknown> {
  const body = res.body as { result: { content: { text: string }[] } };
  return JSON.parse(body.result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

afterEach(async () => {
  await ctx.repo.close();
});

describe('health check', () => {
  it('answers without authentication', async () => {
    const res = await request(makeApp()).get('/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', name: 'issue-tracker-mcp' });
  });
});

describe('authentication', () => {
  it('rejects a request without a token (401 + WWW-Authenticate)', async () => {
    const res = await request(makeApp())
      .post('/mcp')
      .set('Accept', ACCEPT)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(401);

    expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
    expect(res.body).toMatchObject({ jsonrpc: '2.0', error: { code: -32001 }, id: null });
  });

  it('rejects a wrong token and never logs it', async () => {
    const wrong = 'wrong-key-that-must-not-appear-in-logs';
    await rpc(makeApp(), 'tools/list', {}, wrong).expect(401);

    expect(ctx.logs).toContainEqual(
      expect.objectContaining({
        event: 'auth_failed',
        reason: 'invalid_key',
        requestId: expect.any(String) as string,
      }),
    );
    expect(JSON.stringify(ctx.logs)).not.toContain(wrong);
  });

  it('accepts the correct token', async () => {
    const res = await rpc(makeApp(), 'tools/list').expect(200);
    expect((res.body as { result: { tools: unknown[] } }).result.tools).toHaveLength(8);
  });
});

describe('MCP over Streamable HTTP (stateless)', () => {
  it('handles initialize and returns JSON (not SSE)', async () => {
    const res = await rpc(makeApp(), 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    }).expect(200);

    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['mcp-session-id']).toBeUndefined(); // stateless: no session
    expect(res.body).toMatchObject({ result: { serverInfo: { name: 'issue-tracker-mcp' } } });
  });

  it('shares data across independent requests through the repository', async () => {
    const app = makeApp();
    const created = await callTool(app, 'create_issue', {
      title: 'Checkout fails',
      description: 'Card payment times out',
      priority: 'high',
    }).expect(200);
    const id = (toolData(created).issue as { id: string }).id;

    const fetched = await callTool(app, 'get_issue', { id }).expect(200);
    expect(toolData(fetched)).toMatchObject({ id, title: 'Checkout fails' });
  });

  it('returns tool errors as isError results (HTTP 200)', async () => {
    const res = await callTool(makeApp(), 'get_issue', { id: 'iss_000000000000' }).expect(200);
    expect(res.body).toMatchObject({ result: { isError: true } });
  });

  it('rejects GET and DELETE with 405 in stateless mode', async () => {
    const app = makeApp();
    for (const method of ['get', 'delete'] as const) {
      const res = await request(app)
        [method]('/mcp')
        .set('Authorization', `Bearer ${API_KEY}`)
        .expect(405);
      expect(res.headers.allow).toBe('POST');
    }
  });
});

describe('guardrails', () => {
  it('rejects a body over the size limit with 413, before it reaches MCP', async () => {
    const res = await callTool(makeApp({ maxBodyBytes: 2_048 }), 'create_issue', {
      title: 't',
      description: 'x'.repeat(5_000),
      priority: 'low',
    }).expect(413);

    expect(res.body).toMatchObject({ error: { code: -32600 } });
    expect(await ctx.repo.listIssues()).toEqual([]);
  });

  it('rejects malformed JSON with a JSON-RPC parse error', async () => {
    const res = await request(makeApp())
      .post('/mcp')
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Accept', ACCEPT)
      .set('Content-Type', 'application/json')
      .send('{"jsonrpc": "2.0",')
      .expect(400);
    expect(res.body).toMatchObject({ error: { code: -32700 } });
  });

  it('rate-limits per client, counting unauthenticated attempts too', async () => {
    const app = makeApp({ rateLimitPerMinute: 2 });
    await rpc(app, 'tools/list').expect(200);
    await rpc(app, 'tools/list', {}, 'bad-key').expect(401);

    const res = await rpc(app, 'tools/list').expect(429);
    expect(res.body).toMatchObject({
      error: { message: expect.stringMatching(/Too many/) as string },
    });
    expect(res.headers.ratelimit).toBeDefined();
    expect(ctx.logs).toContainEqual(expect.objectContaining({ event: 'rate_limited' }));
  });

  it('rejects unexpected Host headers (DNS-rebinding protection on localhost)', async () => {
    await request(makeApp()).get('/health').set('Host', 'evil.example.com').expect(403);
  });

  it('honours an explicit allowed-hosts list', async () => {
    const app = makeApp({ allowedHosts: ['mcp.example.com'] });
    await request(app).get('/health').set('Host', 'mcp.example.com').expect(200);
    await request(app).get('/health').set('Host', 'other.example.com').expect(403);
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(makeApp()).get('/nope').expect(404);
    expect(res.body).toMatchObject({ error: { code: -32601 } });
  });

  it('does not advertise the framework', async () => {
    const res = await request(makeApp()).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('logging', () => {
  it('writes an access log and a tool_call log sharing one request id', async () => {
    const app = makeApp();
    const res = await callTool(app, 'list_issues', {}).set('x-request-id', 'req-123').expect(200);

    expect(res.headers['x-request-id']).toBe('req-123');
    expect(ctx.logs).toContainEqual(
      expect.objectContaining({
        event: 'tool_call',
        tool: 'list_issues',
        outcome: 'success',
        requestId: 'req-123',
      }),
    );
    expect(ctx.logs).toContainEqual(
      expect.objectContaining({
        event: 'http_request',
        method: 'POST',
        path: '/mcp',
        status: 200,
        requestId: 'req-123',
      }),
    );
  });

  it('generates a request id when the client sends an unsafe one', async () => {
    const res = await request(makeApp()).get('/health').set('x-request-id', 'bad id {"x":1}');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('never logs the Authorization header', async () => {
    await rpc(makeApp(), 'tools/list').expect(200);
    expect(JSON.stringify(ctx.logs)).not.toContain(API_KEY);
  });
});
