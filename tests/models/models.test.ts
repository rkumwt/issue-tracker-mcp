import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ConfigError } from '../../src/lib/errors.js';
import { newCommentId, newIssueId } from '../../src/lib/ids.js';
import {
  ISSUE_STATUSES,
  clampLimit,
  normalizeLabels,
  type IssueStatus,
} from '../../src/models/issue.js';
import { assertTransition, canTransition } from '../../src/models/workflow.js';

describe('normalizeLabels', () => {
  it('trims, lower-cases, removes empties and duplicates, keeping order', () => {
    expect(normalizeLabels([' UI', 'bug', 'ui', '', '  ', 'Bug'])).toEqual(['ui', 'bug']);
  });

  it('returns an empty array for undefined', () => {
    expect(normalizeLabels(undefined)).toEqual([]);
  });
});

describe('clampLimit', () => {
  it.each([
    [undefined, 50],
    [10, 10],
    [0, 1],
    [-3, 1],
    [999, 200],
    [7.9, 7],
    [Number.NaN, 50],
  ])('clampLimit(%s) = %s', (input, expected) => {
    expect(clampLimit(input)).toBe(expected);
  });
});

describe('ids', () => {
  it('generates prefixed 12-hex-char ids', () => {
    expect(newIssueId()).toMatch(/^iss_[0-9a-f]{12}$/);
    expect(newCommentId()).toMatch(/^cmt_[0-9a-f]{12}$/);
  });

  it('does not repeat across many calls', () => {
    const ids = new Set(Array.from({ length: 10_000 }, newIssueId));
    expect(ids.size).toBe(10_000);
  });
});

describe('status workflow', () => {
  // The full matrix, so any change to the rules is a deliberate test change.
  const allowed: Record<IssueStatus, IssueStatus[]> = {
    open: ['in_progress', 'resolved', 'closed'],
    in_progress: ['open', 'resolved', 'closed'],
    resolved: ['closed', 'open'],
    closed: ['open'],
  };

  for (const from of ISSUE_STATUSES) {
    for (const to of ISSUE_STATUSES.filter((s) => s !== from)) {
      const expected = allowed[from].includes(to);
      it(`${from} → ${to} is ${expected ? 'allowed' : 'rejected'}`, () => {
        expect(canTransition(from, to)).toBe(expected);
      });
    }
  }

  it('assertTransition explains which moves are allowed', () => {
    expect(() => {
      assertTransition('closed', 'resolved');
    }).toThrow('Cannot change status from "closed" to "resolved". Allowed from "closed": open.');
  });
});

describe('loadConfig', () => {
  it('defaults to sqlite with an absolute path inside the project', () => {
    const config = loadConfig({});
    expect(config.storage).toBe('sqlite');
    expect(config.sqlitePath).toMatch(/^\/.*\/data\/issues\.db$/);
  });

  it('reads explicit values', () => {
    expect(loadConfig({ STORAGE: 'dynamodb', SQLITE_PATH: ':memory:' })).toEqual({
      storage: 'dynamodb',
      sqlitePath: ':memory:',
    });
  });

  it('fails fast with a readable error on an invalid STORAGE value', () => {
    expect(() => loadConfig({ STORAGE: 'mongo' })).toThrow(ConfigError);
    expect(() => loadConfig({ STORAGE: 'mongo' })).toThrow(/STORAGE/);
  });
});
