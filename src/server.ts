/**
 * createServer(): builds the MCP server with all tools, resources and prompts.
 *
 * Design decision: this function is TRANSPORT-AGNOSTIC. It knows nothing about
 * stdio, HTTP or Lambda. Each entry point (stdio.ts, http.ts, lambda.ts) creates
 * a repository, calls createServer(), and connects the result to its own
 * transport. Behaviour is therefore identical everywhere, and tests can drive
 * the server through an in-memory transport.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from './context.js';
import type { IssueRepository } from './db/IssueRepository.js';
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';
import { registerTools } from './tools/index.js';

export const SERVER_NAME = 'issue-tracker-mcp';
export const SERVER_VERSION = '0.2.0';

/**
 * Sent to the client during initialisation. Many clients add it to the system
 * prompt, so it is the place for cross-tool guidance that doesn't belong to any
 * single tool description.
 */
const INSTRUCTIONS = `Issue tracker for a software team.
- Search (search_issues) before creating to avoid duplicates.
- Change status only with change_status; read issues://workflow for the allowed transitions and priority definitions.
- Record reasons for changes with add_comment.
- Never call delete_issue with confirm: true unless the user explicitly asked to permanently delete that issue; prefer closing.
- list/search results shorten descriptions; use get_issue for full details and comments.`;

export interface CreateServerOptions {
  repo: IssueRepository;
  /** Override the clock (tests). Defaults to the real time. */
  now?: () => Date;
}

export function createServer({ repo, now = () => new Date() }: CreateServerOptions): McpServer {
  const ctx: AppContext = { repo, now };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  registerTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server, ctx);

  return server;
}
