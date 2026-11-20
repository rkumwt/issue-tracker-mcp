#!/usr/bin/env node
/**
 * Streamable HTTP entry point, for remote MCP clients.
 *
 *   MCP_API_KEY=$(openssl rand -hex 32) npm run dev:http
 *
 * Clients POST JSON-RPC messages to http://HOST:PORT/mcp with
 * `Authorization: Bearer <MCP_API_KEY>`. On AWS the same Express app runs
 * inside Lambda (src/lambda.ts, phase 5) instead of calling listen().
 */
import { loadConfig, loadHttpConfig } from './config.js';
import { createRepository } from './db/index.js';
import { createHttpApp } from './httpApp.js';
import { createLogger } from './lib/logger.js';
import { SERVER_NAME, SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, base: { service: SERVER_NAME } });
  const http = loadHttpConfig();
  const repo = await createRepository(config);

  const app = createHttpApp({ repo, logger, ...http });
  const server = app.listen(http.port, http.host, () => {
    logger.info('http server listening', {
      version: SERVER_VERSION,
      url: `http://${http.host}:${http.port}/mcp`,
      storage: config.storage,
      rateLimitPerMinute: http.rateLimitPerMinute,
    });
  });

  // Graceful shutdown: stop accepting connections, let in-flight requests
  // finish, then close the database.
  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { reason });
    server.close(() => {
      void repo.close().then(() => process.exit(0));
    });
    // Don't hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}

main().catch((err: unknown) => {
  // The logger may not exist yet (e.g. invalid config), so log plain JSON here.
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'fatal startup error',
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
