/**
 * Registers every tool on an McpServer.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { addCommentTool } from './addComment.js';
import { changeStatusTool } from './changeStatus.js';
import { createIssueTool } from './createIssue.js';
import { deleteIssueTool } from './deleteIssue.js';
import { getIssueTool } from './getIssue.js';
import { listIssuesTool } from './listIssues.js';
import { runTool } from './runTool.js';
import { searchIssuesTool } from './searchIssues.js';
import type { ToolContext, ToolDefinition } from './types.js';
import { updateIssueTool } from './updateIssue.js';

export type { ToolContext } from './types.js';

function register<Shape extends z.ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  tool: ToolDefinition<Shape>,
): void {
  // Widen to the non-generic shape type: the SDK's callback signature is a
  // conditional type that TypeScript cannot resolve for a generic `Shape`.
  const inputSchema: z.ZodRawShape = tool.inputSchema;

  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema,
      annotations: tool.annotations,
    },
    // The SDK has already validated `args` against inputSchema at this point,
    // so narrowing back to this tool's precise arg type is safe.
    (args) => runTool(tool, args as z.output<z.ZodObject<Shape>>, ctx),
  );
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  // Each call is generic over that tool's own schema, so types stay precise.
  register(server, ctx, createIssueTool);
  register(server, ctx, getIssueTool);
  register(server, ctx, listIssuesTool);
  register(server, ctx, updateIssueTool);
  register(server, ctx, changeStatusTool);
  register(server, ctx, addCommentTool);
  register(server, ctx, searchIssuesTool);
  register(server, ctx, deleteIssueTool);
}
