#!/usr/bin/env node
/**
 * stdio entry point, for local clients (Claude Desktop, MCP Inspector, Claude Code).
 *
 * The client launches this file as a child process and exchanges JSON-RPC
 * messages over stdin/stdout. Consequence: stdout belongs to the protocol.
 * A single stray console.log() would corrupt the stream, so all diagnostics go
 * to stderr (the JSON logger), which clients show in their logs.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createRepository } from './db/index.js';
import { createLogger } from './lib/logger.js';
import { LoggingTransport } from './lib/loggingTransport.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    base: { service: SERVER_NAME, transport: 'stdio' },
  });
  const repo = await createRepository(config);
  const server = createServer({ repo, logger });

  // Graceful shutdown: close the MCP session and the database handle
  // (flushes the SQLite WAL) when the client stops us.
  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { reason });
    await server.close();
    await repo.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // The client closing our stdin also means "we're done".
  process.stdin.on('close', () => void shutdown('stdin closed'));

  await server.connect(new LoggingTransport(new StdioServerTransport(), logger));
  logger.info('stdio server running', {
    version: SERVER_VERSION,
    storage: config.storage,
    ...(config.storage === 'sqlite' && { db: config.sqlitePath }),
  });
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'fatal startup error',
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
