/**
 * `issues://workflow`: markdown documentation of the status rules and
 * priority definitions.
 *
 * The markdown is GENERATED from models/workflow.ts, the same constants the
 * change_status tool enforces, so the docs the LLM reads can't go stale.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from '../models/issue.js';
import {
  PRIORITY_DEFINITIONS,
  STATUS_DESCRIPTIONS,
  STATUS_TRANSITIONS,
} from '../models/workflow.js';

export const WORKFLOW_URI = 'issues://workflow';

export function buildWorkflowMarkdown(): string {
  const statusRows = ISSUE_STATUSES.map(
    (s) =>
      `| \`${s}\` | ${STATUS_DESCRIPTIONS[s]} | ${STATUS_TRANSITIONS[s].map((t) => `\`${t}\``).join(', ')} |`,
  );

  // Highest priority first reads more naturally.
  const priorityRows = [...ISSUE_PRIORITIES]
    .reverse()
    .map(
      (p) =>
        `| \`${p}\` | ${PRIORITY_DEFINITIONS[p].meaning} | ${PRIORITY_DEFINITIONS[p].response} |`,
    );

  return [
    '# Issue workflow',
    '',
    '## Statuses',
    '',
    '| Status | Meaning | Can move to |',
    '| --- | --- | --- |',
    ...statusRows,
    '',
    '## Priorities',
    '',
    '| Priority | When to use | Expected response |',
    '| --- | --- | --- |',
    ...priorityRows,
    '',
    '## Rules',
    '',
    '1. Every new issue starts as `open`.',
    '2. Change status only with the `change_status` tool; illegal moves are rejected.',
    '3. An issue that is `in_progress` should have an assignee.',
    '4. Record the reason for a status or priority change with `add_comment`.',
    '5. Prefer closing over deleting. `delete_issue` is permanent and needs `confirm: true`',
    '   after the user has explicitly agreed.',
    '6. Search before creating to avoid duplicate issues.',
    '',
  ].join('\n');
}

export function registerWorkflowResource(server: McpServer): void {
  server.registerResource(
    'issue-workflow',
    WORKFLOW_URI,
    {
      title: 'Issue workflow and priority guide',
      description:
        'Markdown guide to the allowed status transitions, what each priority means, and ' +
        'house rules. Read this before triaging or changing statuses.',
      mimeType: 'text/markdown',
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: buildWorkflowMarkdown() }],
    }),
  );
}
