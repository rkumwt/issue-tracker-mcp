/**
 * AWS Lambda entry point: API Gateway (HTTP API) → Lambda → the SAME Express
 * app that `npm run dev:http` serves locally.
 *
 * How it fits together:
 *  - @codegenie/serverless-express converts the API Gateway event into a Node
 *    request, runs the Express app, and converts the response back.
 *  - The app is already STATELESS (phase 4): every POST /mcp builds a fresh MCP
 *    server, so it does not matter which Lambda instance gets which request.
 *  - JSON responses (no SSE) suit API Gateway, which buffers Lambda responses.
 *
 * Cold start vs warm invocations: everything expensive (reading the API key
 * from SSM, creating the DynamoDB client, building the Express app) happens
 * ONCE per container in `init()` and is reused by later invocations. If init
 * fails (e.g. SSM throttled), the cached promise is cleared so the next
 * invocation retries instead of failing forever.
 *
 * Secrets: the API key lives in SSM Parameter Store as a SecureString. Lambda
 * receives only the parameter NAME (MCP_API_KEY_PARAMETER) and reads the value
 * at runtime, so the key never appears in the Lambda configuration, the
 * CloudFormation template or the GitHub repository.
 */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { configure as serverlessExpress } from '@codegenie/serverless-express';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { loadConfig, loadHttpConfig } from './config.js';
import type { IssueRepository } from './db/IssueRepository.js';
import { createRepository } from './db/index.js';
import { createHttpApp } from './httpApp.js';
import { ConfigError } from './lib/errors.js';
import { createLogger, type Logger } from './lib/logger.js';
import { SERVER_NAME, SERVER_VERSION } from './server.js';

export type LambdaHandler = (
  event: APIGatewayProxyEventV2,
  context: Context,
) => Promise<APIGatewayProxyResultV2>;

/** The minimal slice of SSMClient we use (lets tests pass a fake). */
export interface ParameterReader {
  send(command: GetParameterCommand): Promise<{ Parameter?: { Value?: string } }>;
}

/**
 * Resolve the API key: from SSM when MCP_API_KEY_PARAMETER is set (AWS), or
 * from MCP_API_KEY directly (handy for running the handler locally).
 */
export async function loadApiKey(
  env: NodeJS.ProcessEnv,
  ssm: ParameterReader = new SSMClient({}),
): Promise<string> {
  const parameterName = env.MCP_API_KEY_PARAMETER;
  if (parameterName) {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
    );
    if (!Parameter?.Value) throw new ConfigError(`SSM parameter ${parameterName} has no value`);
    return Parameter.Value;
  }
  if (env.MCP_API_KEY) return env.MCP_API_KEY;
  throw new ConfigError('Set MCP_API_KEY_PARAMETER (SSM parameter name) or MCP_API_KEY');
}

export interface LambdaDeps {
  repo: IssueRepository;
  logger: Logger;
  apiKey: string;
  env?: NodeJS.ProcessEnv;
}

/** Build the API Gateway → Express handler from ready dependencies (unit-testable). */
export function createLambdaHandler({ repo, logger, apiKey, env = {} }: LambdaDeps): LambdaHandler {
  // Validates limits, key length etc. exactly like the local HTTP server.
  const http = loadHttpConfig({ TRUST_PROXY: '1', ...env, MCP_API_KEY: apiKey });
  const app = createHttpApp({
    repo,
    logger,
    ...http,
    // Behind API Gateway the Host header is the API's domain, so the localhost
    // check does not apply. Auth protects the endpoint; ALLOWED_HOSTS can pin
    // a custom domain if you add one.
    host: '0.0.0.0',
  });
  return serverlessExpress({ app }) as unknown as LambdaHandler;
}

let initialised: Promise<LambdaHandler> | undefined;

async function init(): Promise<LambdaHandler> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    base: { service: SERVER_NAME, transport: 'lambda' },
  });
  const [apiKey, repo] = await Promise.all([loadApiKey(process.env), createRepository(config)]);
  logger.info('lambda initialised', { version: SERVER_VERSION, storage: config.storage });
  return createLambdaHandler({ repo, logger, apiKey, env: process.env });
}

export const handler: LambdaHandler = async (event, context) => {
  initialised ??= init().catch((err: unknown) => {
    initialised = undefined; // retry on the next invocation
    throw err;
  });
  const run = await initialised;
  return run(event, context);
};
