import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { registerSummaryResource } from './summary.js';
import { registerWorkflowResource } from './workflow.js';

export function registerResources(server: McpServer, ctx: AppContext): void {
  registerSummaryResource(server, ctx);
  registerWorkflowResource(server);
}
