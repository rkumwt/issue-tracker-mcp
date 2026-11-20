/**
 * ID generation.
 *
 * Design decision: short, prefixed, random IDs ("iss_3f9a1c2b7d4e") instead of
 * auto-increment integers or full UUIDs.
 *  - Random (not auto-increment) works identically in SQLite and DynamoDB,
 *    which has no sequences, and needs no coordination between Lambda instances.
 *  - Short + prefixed is LLM-friendly: the model copies the ID between tool
 *    calls, and a 16-char token is far less likely to be mangled than a
 *    36-char UUID. The prefix also makes it obvious which entity an ID belongs to.
 *  - 12 hex chars = 48 bits of randomness, which is plenty for a single team's
 *    issue tracker (collision odds stay negligible below millions of rows).
 */
import { randomUUID } from 'node:crypto';

function randomToken(length = 12): string {
  return randomUUID().replace(/-/g, '').slice(0, length);
}

export const newIssueId = (): string => `iss_${randomToken()}`;
export const newCommentId = (): string => `cmt_${randomToken()}`;
