/**
 * Regression test: the Lambda bundle must load with NO node_modules available.
 *
 * Lambda's /var/task contains only index.mjs. A bundle that still imports an
 * external package (e.g. the native better-sqlite3 addon) crashes at init with
 * ERR_MODULE_NOT_FOUND and every request returns 500. That happened on the
 * first real deployment: tests that ran the bundle from inside the repo passed,
 * because Node quietly resolved the package from the project's node_modules.
 *
 * So this test copies the bundle into an empty temp directory (no node_modules
 * anywhere above it), imports it and invokes GET /health, which needs no
 * network (no DynamoDB or SSM calls).
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { IssueTrackerStack } from '../lib/issue-tracker-stack.js';

/** Synthesize the stack and return the directory of the bundled Lambda code. */
function bundleDirectory(): string {
  const app = new App({ context: { 'aws:cdk:enable-asset-metadata': true } });
  const stack = new IssueTrackerStack(app, 'BundleTest', {
    env: { account: '123456789012', region: 'ap-south-1' },
    apiKeyParameterName: '/issue-tracker-mcp/api-key',
  });
  const template = Template.fromStack(stack);
  const assembly = app.synth();
  const [fn] = Object.values(template.findResources('AWS::Lambda::Function'));
  const assetPath = (fn?.Metadata as Record<string, string> | undefined)?.['aws:asset:path'];
  assert.ok(assetPath, 'Lambda asset path not found in template metadata');
  return path.join(assembly.directory, assetPath);
}

describe('Lambda bundle', () => {
  const isolated = mkdtempSync(path.join(tmpdir(), 'lambda-bundle-'));
  after(() => {
    rmSync(isolated, { recursive: true, force: true });
  });

  it('loads and serves /health without any node_modules (like /var/task)', async () => {
    copyFileSync(path.join(bundleDirectory(), 'index.mjs'), path.join(isolated, 'index.mjs'));

    Object.assign(process.env, {
      STORAGE: 'dynamodb',
      DYNAMODB_TABLE: 'bundle-test',
      AWS_REGION: 'ap-south-1',
      MCP_API_KEY: 'bundle-test-key-0123456789abcdef0123456789', // skips SSM
      LOG_LEVEL: 'error',
    });

    // This import is what failed in production (ERR_MODULE_NOT_FOUND).
    const bundle = (await import(pathToFileURL(path.join(isolated, 'index.mjs')).href)) as {
      handler: (event: unknown, context: unknown) => Promise<{ statusCode: number; body: string }>;
    };
    assert.equal(typeof bundle.handler, 'function');

    const host = 'abc.execute-api.ap-south-1.amazonaws.com';
    const res = await bundle.handler(
      {
        version: '2.0',
        routeKey: '$default',
        rawPath: '/health',
        rawQueryString: '',
        headers: { host },
        requestContext: {
          accountId: '123456789012',
          apiId: 'abc',
          domainName: host,
          domainPrefix: 'abc',
          http: {
            method: 'GET',
            path: '/health',
            protocol: 'HTTP/1.1',
            sourceIp: '198.51.100.1',
            userAgent: 'test',
          },
          requestId: 'bundle-test',
          routeKey: '$default',
          stage: '$default',
          time: '',
          timeEpoch: 0,
        },
        isBase64Encoded: false,
      },
      {},
    );
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.body, /"status":"ok"/);
  });
});
