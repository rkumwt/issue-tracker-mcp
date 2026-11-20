/**
 * Helpers for embedding issue data inside prompt text.
 *
 * Security note (prompt injection): issue titles and descriptions are written
 * by users, so they may contain text like "ignore previous instructions".
 * Prompts therefore wrap the data in clearly delimited <issues> blocks and tell
 * the model to treat their contents as data only. This reduces the risk; it
 * doesn't remove it.
 */
import type { Issue } from '../models/issue.js';
import { truncate } from '../tools/format.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days between an ISO timestamp and `now` (never negative). */
export function ageInDays(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS));
}

/** One compact line per issue: token-efficient but still complete enough to reason about. */
export function issueLine(issue: Issue, now: Date): string {
  const labels = issue.labels.length > 0 ? issue.labels.join(', ') : 'none';
  const description = truncate(issue.description.replace(/\s+/g, ' '), 160);
  return (
    `- [${issue.id}] ${issue.title}\n` +
    `  priority=${issue.priority} status=${issue.status} assignee=${issue.assignee ?? 'UNASSIGNED'} ` +
    `labels=${labels} age=${ageInDays(issue.createdAt, now)}d ` +
    `last_update=${ageInDays(issue.updatedAt, now)}d ago\n` +
    `  ${description}`
  );
}

/** A delimited data block. Says "(none)" rather than leaving it empty. */
export function issuesBlock(issues: Issue[], now: Date): string {
  const body = issues.length > 0 ? issues.map((i) => issueLine(i, now)).join('\n') : '(none)';
  return `<issues>\n${body}\n</issues>`;
}
