import { describe, expect, it } from 'vitest';
import { createLogger, redact } from '../../src/lib/logger.js';

function capture(level: Parameters<typeof createLogger>[0] = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    now: () => new Date('2026-11-18T10:00:00.000Z'),
    write: (line) => lines.push(line),
    ...level,
  });
  return {
    logger,
    lines,
    parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('createLogger', () => {
  it('writes one JSON object per line with time, level and msg first', () => {
    const { logger, lines } = capture();
    logger.info('tool call', { tool: 'get_issue', durationMs: 3 });
    expect(lines).toEqual([
      '{"time":"2026-11-18T10:00:00.000Z","level":"info","msg":"tool call","tool":"get_issue","durationMs":3}',
    ]);
  });

  it('drops entries below the configured level', () => {
    const { logger, parsed } = capture({ level: 'warn' });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(parsed().map((e) => e.level)).toEqual(['warn', 'error']);
  });

  it('defaults to info level', () => {
    const { logger, lines } = capture();
    logger.debug('hidden');
    expect(lines).toEqual([]);
  });

  it('child loggers add their fields to every entry', () => {
    const { logger, parsed } = capture({ base: { service: 'svc' } });
    logger.child({ requestId: 'r1' }).info('hello', { extra: true });
    expect(parsed()[0]).toMatchObject({ service: 'svc', requestId: 'r1', extra: true });
  });

  it('does not let fields overwrite time, level or msg', () => {
    const { logger, parsed } = capture();
    logger.info('real', { level: 'error', msg: 'fake', time: 'never' });
    expect(parsed()[0]).toMatchObject({
      level: 'info',
      msg: 'real',
      time: '2026-11-18T10:00:00.000Z',
    });
  });

  it('redacts secrets anywhere in the fields', () => {
    const { logger, lines } = capture();
    logger.info('request', {
      headers: { Authorization: 'Bearer abc123', 'x-api-key': 'k' },
      nested: [{ password: 'p', token: 't', ok: 'visible' }],
      apiKey: 'top-level',
    });
    const line = lines[0] ?? '';
    for (const secret of ['abc123', '"k"', '"p"', '"t"', 'top-level']) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain('visible');
    expect(line).toContain('[REDACTED]');
  });
});

describe('redact', () => {
  it('serialises errors with name, message, code and stack', () => {
    const err = Object.assign(new Error('boom'), { code: 'E_BOOM' });
    expect(redact(err)).toMatchObject({ name: 'Error', message: 'boom', code: 'E_BOOM' });
    expect((redact(err) as { stack: string }).stack).toContain('boom');
  });

  it('stops at a maximum depth', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } };
    expect(JSON.stringify(redact(deep))).toContain('[Truncated]');
  });

  it('passes primitives through unchanged', () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    expect(redact('text')).toBe('text');
  });
});
