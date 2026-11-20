/**
 * runTool() is the single place where handler outcomes become MCP results,
 * so its error mapping is tested on its own.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NotFoundError } from '../../src/lib/errors.js';
import { ERROR_CODE_META_KEY } from '../../src/lib/loggingTransport.js';
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

describe('runTool', () => {
  it('serialises a successful result as pretty JSON text', async () => {
    const result = await runTool(
      fakeTool(async () => ({ ok: true })),
      { value: 'x' },
      createTestContext(),
    );
    expect(result).toEqual({ content: [{ type: 'text', text: '{\n  "ok": true\n}' }] });
    expect(result.isError).toBeUndefined();
  });

  it('turns an AppError into an isError result with code, message and _meta code', async () => {
    const result = await runTool(
      fakeTool(async () => {
        throw new NotFoundError('Issue', 'iss_123');
      }),
      { value: 'x' },
      createTestContext(),
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: 'NOT_FOUND: Issue iss_123 not found' }],
      isError: true,
      _meta: { [ERROR_CODE_META_KEY]: 'NOT_FOUND' },
    });
  });

  it('hides unexpected error details from the client but logs them', async () => {
    const ctx = createTestContext();
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

    expect(ctx.logs).toHaveLength(1);
    expect(ctx.logs[0]).toMatchObject({
      level: 'error',
      msg: 'unexpected tool error',
      tool: 'fake_tool',
      err: { name: 'Error', message: 'SQLITE_CORRUPT: secret internal detail' },
    });
  });
});
