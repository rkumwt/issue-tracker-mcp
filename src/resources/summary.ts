/**
 * `issues://summary`: live counts by status and priority.
 *
 * Resources vs tools: a resource is READ-ONLY context the client (or user) can
 * attach to a conversation, addressed by a URI. It has no side effects and no
 * input arguments, which makes it a good fit for a dashboard-style snapshot.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';

export const SUMMARY_URI = 'issues://summary';

export async function buildSummary({ repo, now }: AppContext): Promise<object> {
  const summary = await repo.getSummary();
  return {
    ...summary,
    // Convenience figure: everything not yet resolved or closed.
    active: summary.byStatus.open + summary.byStatus.in_progress,
    generatedAt: now().toISOString(),
  };
}

export function registerSummaryResource(server: McpServer, ctx: AppContext): void {
  server.registerResource(
    'issue-summary',
    SUMMARY_URI,
    {
      title: 'Issue summary',
      description:
        'Live counts of issues by status and by priority, plus the number of active ' +
        '(open + in_progress) issues. Read-only.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await buildSummary(ctx), null, 2),
        },
      ],
    }),
  );
}
