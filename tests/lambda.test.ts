/**
 * Lambda handler tests: realistic API Gateway HTTP API (payload v2) events go
 * through serverless-express into the real Express app, backed by SQLite.
 */
import type { GetParameterCommand } from '@aws-sdk/client-ssm';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLambdaHandler, loadApiKey, type LambdaHandler } from '../src/lambda.js';
import { createTestContext, type TestContext } from './helpers.js';

const API_KEY = 'lambda-test-key-0123456789abcdef0123456789';
const DOMAIN = 'abc123.execute-api.eu-west-1.amazonaws.com';

function apiGatewayEvent(options: {
  method?: string;
  path?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): APIGatewayProxyEventV2 {
  const method = options.method ?? 'POST';
  const path = options.path ?? '/mcp';
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: {
      host: DOMAIN,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-forwarded-for': '203.0.113.7',
      ...options.headers,
    },
    requestContext: {
      accountId: '123456789012',
      apiId: 'abc123',
      domainName: DOMAIN,
      domainPrefix: 'abc123',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '203.0.113.7', userAgent: 'test' },
      requestId: 'apigw-request-1',
      routeKey: '$default',
      stage: '$default',
      time: '20/Nov/2026:10:00:00 +0000',
      timeEpoch: 1_795_000_000_000,
    },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    isBase64Encoded: false,
  };
}

const context = { awsRequestId: 'lambda-request-1' } as Context;

let ctx: TestContext;
let handler: LambdaHandler;

async function invoke(event: APIGatewayProxyEventV2) {
  const result = (await handler(event, context)) as APIGatewayProxyStructuredResultV2;
  return { ...result, json: JSON.parse(result.body ?? '{}') as Record<string, unknown> };
}

const rpc = (method: string, params: object = {}) =>
  apiGatewayEvent({
    headers: { authorization: `Bearer ${API_KEY}` },
    body: { jsonrpc: '2.0', id: 1, method, params },
  });

beforeEach(() => {
  ctx = createTestContext();
  handler = createLambdaHandler({ repo: ctx.repo, logger: ctx.logger, apiKey: API_KEY });
});

afterEach(async () => {
  await ctx.repo.close();
});

describe('Lambda handler (API Gateway HTTP API v2 events)', () => {
  it('serves the health check', async () => {
    const res = await invoke(apiGatewayEvent({ method: 'GET', path: '/health' }));
    expect(res.statusCode).toBe(200);
    expect(res.json).toMatchObject({ status: 'ok' });
  });

  it('rejects requests without the API key', async () => {
    const res = await invoke(apiGatewayEvent({ body: { jsonrpc: '2.0', id: 1, method: 'ping' } }));
    expect(res.statusCode).toBe(401);
  });

  it('accepts the API Gateway Host header (no localhost check behind API Gateway)', async () => {
    const res = await invoke(rpc('tools/list'));
    expect(res.statusCode).toBe(200);
    expect((res.json.result as { tools: unknown[] }).tools).toHaveLength(8);
  });

  it('runs tool calls end to end', async () => {
    const created = await invoke(
      rpc('tools/call', {
        name: 'create_issue',
        arguments: { title: 'From Lambda', description: 'via API Gateway', priority: 'low' },
      }),
    );
    expect(created.statusCode).toBe(200);
    expect(await ctx.repo.listIssues()).toEqual([
      expect.objectContaining({ title: 'From Lambda' }),
    ]);
  });

  it('enforces the body size limit even though the body arrives pre-read', async () => {
    const res = await invoke(
      apiGatewayEvent({
        headers: { authorization: `Bearer ${API_KEY}` },
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'create_issue',
            arguments: { title: 't', description: 'x'.repeat(200_000), priority: 'low' },
          },
        },
      }),
    );
    expect(res.statusCode).toBe(413);
    expect(await ctx.repo.listIssues()).toEqual([]);
  });

  it('answers malformed JSON with a JSON-RPC parse error', async () => {
    const event = apiGatewayEvent({ headers: { authorization: `Bearer ${API_KEY}` } });
    event.body = '{"jsonrpc": "2.0",';
    const res = await invoke(event);
    expect(res.statusCode).toBe(400);
    expect(res.json).toMatchObject({ error: { code: -32700 } });
  });

  it('logs with the client IP taken from X-Forwarded-For', async () => {
    await invoke(apiGatewayEvent({ body: { jsonrpc: '2.0', id: 1, method: 'ping' } }));
    expect(ctx.logs).toContainEqual(
      expect.objectContaining({ event: 'auth_failed', ip: '203.0.113.7' }),
    );
  });
});

describe('loadApiKey', () => {
  const fakeSsm = (value: string | undefined) => {
    const calls: GetParameterCommand[] = [];
    return {
      calls,
      send: async (command: GetParameterCommand) => {
        calls.push(command);
        return { Parameter: value === undefined ? {} : { Value: value } };
      },
    };
  };

  it('reads and decrypts the SSM parameter named by MCP_API_KEY_PARAMETER', async () => {
    const ssm = fakeSsm(API_KEY);
    const key = await loadApiKey({ MCP_API_KEY_PARAMETER: '/issue-tracker-mcp/api-key' }, ssm);
    expect(key).toBe(API_KEY);
    expect(ssm.calls[0]?.input).toEqual({
      Name: '/issue-tracker-mcp/api-key',
      WithDecryption: true,
    });
  });

  it('prefers SSM over a plain environment variable', async () => {
    const ssm = fakeSsm('from-ssm');
    expect(await loadApiKey({ MCP_API_KEY_PARAMETER: '/p', MCP_API_KEY: 'from-env' }, ssm)).toBe(
      'from-ssm',
    );
  });

  it('falls back to MCP_API_KEY for local runs', async () => {
    expect(await loadApiKey({ MCP_API_KEY: 'from-env' }, fakeSsm(undefined))).toBe('from-env');
  });

  it('fails clearly when the parameter is empty or nothing is configured', async () => {
    await expect(loadApiKey({ MCP_API_KEY_PARAMETER: '/p' }, fakeSsm(undefined))).rejects.toThrow(
      /has no value/,
    );
    await expect(loadApiKey({}, fakeSsm(undefined))).rejects.toThrow(/MCP_API_KEY_PARAMETER/);
  });
});

describe('exported handler (cold start)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('retries initialisation after a failed cold start, then serves requests', async () => {
    vi.resetModules(); // fresh module state = a fresh Lambda container
    const { handler: coldHandler } = await import('../src/lambda.js');
    const health = apiGatewayEvent({ method: 'GET', path: '/health' });

    // 1st invocation: no API key configured → init fails.
    vi.stubEnv('MCP_API_KEY', '');
    vi.stubEnv('MCP_API_KEY_PARAMETER', '');
    vi.stubEnv('SQLITE_PATH', ':memory:');
    vi.stubEnv('LOG_LEVEL', 'error');
    await expect(coldHandler(health, context)).rejects.toThrow(/MCP_API_KEY/);

    // 2nd invocation after the config is fixed → init runs again and succeeds.
    vi.stubEnv('MCP_API_KEY', API_KEY);
    const res = (await coldHandler(health, context)) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(200);
  });
});
