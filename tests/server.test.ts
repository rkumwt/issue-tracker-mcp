/**
 * Protocol-level integration tests.
 *
 * A real MCP Client talks to createServer() through the SDK's in-memory
 * transport. This exercises everything a real client would hit (JSON-RPC,
 * capability negotiation, SDK-side Zod validation, JSON Schema generation)
 * without spawning a process.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVER_NAME, createServer } from '../src/server.js';
import { createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;
let client: Client;

beforeEach(async () => {
  ctx = createTestContext();
  const server = createServer({ repo: ctx.repo, now: ctx.now });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  await ctx.repo.close();
});

/** Call a tool and return its text plus parsed JSON (when it succeeded). */
async function call(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  const text = first?.type === 'text' ? first.text : '';
  return {
    isError: result.isError === true,
    text,
    data: result.isError ? undefined : (JSON.parse(text) as Record<string, unknown>),
  };
}

describe('server metadata', () => {
  it('identifies itself and sends usage instructions', () => {
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    expect(client.getInstructions()).toMatch(/search_issues/);
  });
});

describe('tools/list', () => {
  it('exposes the 8 tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_comment',
      'change_status',
      'create_issue',
      'delete_issue',
      'get_issue',
      'list_issues',
      'search_issues',
      'update_issue',
    ]);
  });

  it('gives every tool a description and every input field a description', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description?.length, tool.name).toBeGreaterThan(50);
      const properties = (tool.inputSchema.properties ?? {}) as Record<
        string,
        { description?: string }
      >;
      for (const [field, schema] of Object.entries(properties)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });

  it('marks read-only and destructive tools with annotations', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('get_issue')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('delete_issue')?.annotations?.destructiveHint).toBe(true);
  });
});

describe('tools/call', () => {
  it('runs a full issue lifecycle', async () => {
    const created = await call('create_issue', {
      title: 'Checkout fails',
      description: 'Card payment times out',
      priority: 'high',
    });
    const id = (created.data?.issue as { id: string }).id;

    await call('change_status', { id, status: 'in_progress' });
    await call('add_comment', { issueId: id, author: 'alice', text: 'Root cause found' });
    await call('change_status', { id, status: 'resolved' });

    const fetched = await call('get_issue', { id });
    expect(fetched.data).toMatchObject({
      status: 'resolved',
      comments: [{ author: 'alice', text: 'Root cause found' }],
    });
  });

  it('returns invalid arguments as an isError result (validated by the SDK)', async () => {
    const result = await call('create_issue', { title: '', description: 'x', priority: 'urgent' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/title/);
    expect(await ctx.repo.listIssues()).toEqual([]);
  });

  it('rejects status changes through update_issue (unknown field)', async () => {
    const created = await call('create_issue', { title: 't', description: 'd', priority: 'low' });
    const id = (created.data?.issue as { id: string }).id;

    const result = await call('update_issue', { id, status: 'closed' });
    expect(result.isError).toBe(true);
    expect((await ctx.repo.getIssue(id))?.status).toBe('open');
  });

  it('reports domain errors with a code the model can act on', async () => {
    const result = await call('get_issue', { id: 'iss_000000000000' });
    expect(result).toMatchObject({
      isError: true,
      text: 'NOT_FOUND: Issue iss_000000000000 not found',
    });
  });

  it('refuses delete_issue without confirmation', async () => {
    const created = await call('create_issue', { title: 't', description: 'd', priority: 'low' });
    const id = (created.data?.issue as { id: string }).id;

    expect((await call('delete_issue', { id, confirm: false })).isError).toBe(true);
    expect(await ctx.repo.getIssue(id)).not.toBeNull();
  });
});

describe('resources', () => {
  it('lists both resources', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(['issues://summary', 'issues://workflow']);
  });

  it('serves the summary as JSON', async () => {
    await ctx.repo.createIssue({ title: 't', description: 'd', priority: 'critical' });
    const { contents } = await client.readResource({ uri: 'issues://summary' });
    const first = contents[0];
    expect(first?.mimeType).toBe('application/json');
    const summary = JSON.parse(first && 'text' in first ? first.text : '{}') as Record<
      string,
      unknown
    >;
    expect(summary).toMatchObject({ total: 1, active: 1, byPriority: { critical: 1 } });
  });

  it('serves the workflow guide as markdown', async () => {
    const { contents } = await client.readResource({ uri: 'issues://workflow' });
    const first = contents[0];
    expect(first?.mimeType).toBe('text/markdown');
    expect(first && 'text' in first ? first.text : '').toMatch(/^# Issue workflow/);
  });
});

describe('prompts', () => {
  it('lists both prompts with their arguments', async () => {
    const { prompts } = await client.listPrompts();
    const byName = new Map(prompts.map((p) => [p.name, p]));
    expect([...byName.keys()].sort()).toEqual(['triage_issues', 'weekly_report']);
    expect(byName.get('triage_issues')?.arguments?.map((a) => a.name)).toEqual(['team']);
    expect(byName.get('weekly_report')?.arguments?.map((a) => a.name)).toEqual(['since']);
  });

  it('renders a prompt with live data', async () => {
    await ctx.repo.createIssue({ title: 'Unassigned crash', description: 'd', priority: 'high' });
    const result = await client.getPrompt({ name: 'triage_issues', arguments: { team: 'alice' } });
    const content = result.messages[0]?.content;
    expect(content?.type).toBe('text');
    expect(content?.type === 'text' ? content.text : '').toContain('Unassigned crash');
  });

  it('rejects an invalid prompt argument', async () => {
    await expect(
      client.getPrompt({ name: 'weekly_report', arguments: { since: 'last monday' } }),
    ).rejects.toThrow();
  });
});
