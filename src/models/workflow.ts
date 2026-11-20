/**
 * Workflow rules: which status changes are allowed, and what each status and
 * priority means.
 *
 * Design decision: this file is the SINGLE SOURCE of the rules. The
 * `change_status` tool enforces them and the `issues://workflow` resource
 * renders them as markdown for the LLM, so the documentation the model reads
 * can never disagree with the behaviour it gets.
 */
import { ConflictError } from '../lib/errors.js';
import type { IssuePriority, IssueStatus } from './issue.js';

/**
 * Allowed transitions (from → to).
 *
 *   open ⇄ in_progress → resolved → closed
 *     └────────────┴──────────┴───────→ closed (won't fix / duplicate)
 *   resolved / closed → open  (reopen)
 */
export const STATUS_TRANSITIONS: Readonly<Record<IssueStatus, readonly IssueStatus[]>> = {
  open: ['in_progress', 'resolved', 'closed'],
  in_progress: ['open', 'resolved', 'closed'],
  resolved: ['closed', 'open'],
  closed: ['open'],
};

export const STATUS_DESCRIPTIONS: Readonly<Record<IssueStatus, string>> = {
  open: 'Reported and accepted, but nobody is actively working on it yet.',
  in_progress: 'Someone is actively working on it. It should have an assignee.',
  resolved: 'A fix or answer has been delivered and is waiting for verification.',
  closed: 'Done: verified fixed, or intentionally not fixed (duplicate, won’t fix).',
};

export const PRIORITY_DEFINITIONS: Readonly<
  Record<IssuePriority, { meaning: string; response: string }>
> = {
  critical: {
    meaning: 'Production down, data loss, security hole, or no workaround for most users.',
    response: 'Start immediately; drop other work.',
  },
  high: {
    meaning: 'Major feature broken or badly degraded; a workaround exists but is painful.',
    response: 'Fix in the current sprint.',
  },
  medium: {
    meaning: 'Real problem with a reasonable workaround, or an important improvement.',
    response: 'Schedule within the next few sprints.',
  },
  low: {
    meaning: 'Cosmetic issue, minor annoyance, or nice-to-have idea.',
    response: 'Backlog; pick up when convenient.',
  },
};

export function canTransition(from: IssueStatus, to: IssueStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Throws a ConflictError that tells the caller (the LLM) which moves ARE
 * allowed, so it can correct itself instead of guessing.
 */
export function assertTransition(from: IssueStatus, to: IssueStatus): void {
  if (!canTransition(from, to)) {
    const allowed = STATUS_TRANSITIONS[from].join(', ');
    throw new ConflictError(
      `Cannot change status from "${from}" to "${to}". Allowed from "${from}": ${allowed}.`,
    );
  }
}
