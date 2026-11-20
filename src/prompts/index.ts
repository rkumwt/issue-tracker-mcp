import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { registerTriagePrompt } from './triage.js';
import { registerWeeklyReportPrompt } from './weeklyReport.js';

export function registerPrompts(server: McpServer, ctx: AppContext): void {
  registerTriagePrompt(server, ctx);
  registerWeeklyReportPrompt(server, ctx);
}
