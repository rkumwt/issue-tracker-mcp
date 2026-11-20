/**
 * runTool() is the single place where handler outcomes become MCP results,
 * so its error mapping is tested on its own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NotFoundError } from '../../src/lib/errors.js';
import { runTool } from '../../src/tools/runTool.js';
import { defineTool } from '../../src/tools/types.js';
import { createTestContext } from '../helpers.js';

function fakeTool(handler: () => Promise<object>) {
  return defineTool({
    name: 'fake_tool',
    title: 'Fake',
    description: 'test',
    inputSchema: { value: z.string() },
    annotations: {},
    handler,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runTool', () => {
  const ctx = createTestContext();

  it('serialises a successful result as pretty JSON text', async () => {
    const result = await runTool(
      fakeTool(async () => ({ ok: true })),
      { value: 'x' },
      ctx,
    );
    expect(result).toEqual({ content: [{ type: 'text', text: '{\n  "ok": true\n}' }] });
    expect(result.isError).toBeUndefined();
  });

  it('turns an AppError into an isError result with code and message', async () => {
    const result = await runTool(
      fakeTool(async () => {
        throw new NotFoundError('Issue', 'iss_123');
      }),
      { value: 'x' },
      ctx,
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: 'NOT_FOUND: Issue iss_123 not found' }],
      isError: true,
    });
  });

  it('hides the details of unexpected errors from the client but logs them to stderr', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await runTool(
      fakeTool(async () => {
        throw new Error('SQLITE_CORRUPT: secret internal detail');
      }),
      { value: 'x' },
      ctx,
    );

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain('INTERNAL');
    expect(text).not.toContain('secret internal detail');
    expect(stderr).toHaveBeenCalledOnce();
  });
});
