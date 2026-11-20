/**
 * The shape every tool in this project follows.
 *
 * Design decision: a tool is a plain object of { metadata, Zod input shape,
 * handler }. The handler receives already-validated args plus a context
 * (dependencies) and simply returns data or throws. It knows nothing about
 * MCP response formats; `runTool()` converts its result or error into a
 * CallToolResult in one place.
 *
 * That separation makes handlers trivial to unit-test: call
 * `tool.handler(args, { repo, now })` and assert on the returned object.
 */
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { AppContext } from '../context.js';

/** Dependencies injected into every tool handler. */
export type ToolContext = AppContext;

export interface ToolDefinition<Shape extends z.ZodRawShape> {
  /** snake_case name the LLM calls, e.g. "create_issue". */
  name: string;
  /** Human-friendly name shown by clients such as MCP Inspector. */
  title: string;
  /**
   * Tells the LLM WHEN to use this tool (and when to use a different one).
   * This is the most important prompt engineering in an MCP server.
   */
  description: string;
  inputSchema: Shape;
  /** Behaviour hints for clients (read-only? destructive? idempotent?). */
  annotations: ToolAnnotations;
  /** Returns JSON-serialisable data, or throws (AppError for expected failures). */
  handler: (args: z.output<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<object>;
}

/** Identity helper that gives full type inference for `args` inside the handler. */
export function defineTool<Shape extends z.ZodRawShape>(
  definition: ToolDefinition<Shape>,
): ToolDefinition<Shape> {
  return definition;
}
