#!/usr/bin/env node
/**
 * stdio entry point, for local clients (Claude Desktop, MCP Inspector, Claude Code).
 *
 * The client launches this file as a child process and exchanges JSON-RPC
 * messages over stdin/stdout. Consequence: stdout belongs to the protocol.
 * A single stray console.log() would corrupt the stream, so all diagnostics go
 * to stderr (console.error), which clients show in their logs.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createRepository } from './db/index.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const repo = await createRepository(config);
  const server = createServer({ repo });

  // Graceful shutdown: close the MCP session and the database handle
  // (flushes the SQLite WAL) when the client stops us.
  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[${SERVER_NAME}] shutting down (${reason})`);
    await server.close();
    await repo.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // The client closing our stdin also means "we're done".
  process.stdin.on('close', () => void shutdown('stdin closed'));

  await server.connect(new StdioServerTransport());
  console.error(
    `[${SERVER_NAME}] v${SERVER_VERSION} running on stdio (storage=${config.storage}` +
      `${config.storage === 'sqlite' ? `, db=${config.sqlitePath}` : ''})`,
  );
}

main().catch((err: unknown) => {
  console.error(`[${SERVER_NAME}] fatal startup error:`, err);
  process.exit(1);
});
