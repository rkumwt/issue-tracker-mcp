/**
 * Converts a tool handler's outcome into an MCP CallToolResult.
 *
 * Error handling follows the MCP convention: failures are returned as a normal
 * result with `isError: true` (not thrown as a protocol error), so the LLM SEES
 * the message and can recover. For example, after "Issue iss_x not found" it can
 * run search_issues and retry.
 *
 *  - AppError (expected: not found, invalid transition, ...) → its message is shown.
 *  - Anything else (a bug, a DB outage) → a generic message only; details are
 *    logged so internals and stack traces never leak to the client.
 *
 * Error results also carry the error code in `_meta`, which LoggingTransport
 * reads to log *why* a call failed without parsing message text.
 *
 * Note: Zod validation of the input happens inside the SDK BEFORE the handler
 * runs; invalid args are already reported back as an isError result.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { isAppError } from '../lib/errors.js';
import { ERROR_CODE_META_KEY } from '../lib/loggingTransport.js';
import type { ToolContext, ToolDefinition } from './types.js';

export function toolSuccess(data: object): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function toolError(code: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    isError: true,
    _meta: { [ERROR_CODE_META_KEY]: code },
  };
}

export async function runTool<Shape extends z.ZodRawShape>(
  tool: ToolDefinition<Shape>,
  args: z.output<z.ZodObject<Shape>>,
  ctx: ToolContext,
): Promise<CallToolResult> {
  try {
    return toolSuccess(await tool.handler(args, ctx));
  } catch (err) {
    if (isAppError(err)) return toolError(err.code, err.message);

    // Unexpected failure: full details go to the log, never to the client.
    ctx.logger.error('unexpected tool error', { tool: tool.name, err });
    return toolError('INTERNAL', `"${tool.name}" failed unexpectedly. Please try again later.`);
  }
}
