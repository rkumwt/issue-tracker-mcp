/**
 * LoggingTransport: a decorator around any MCP Transport that logs every
 * JSON-RPC request with its outcome and duration.
 *
 * Why at the transport level and not inside each tool?
 *  - It sees EVERY tool call, including ones the SDK rejects before our
 *    handler runs (invalid arguments, unknown tool). Logging inside handlers
 *    would silently miss those.
 *  - It works the same for stdio, Streamable HTTP and Lambda, because all of
 *    them implement the same `Transport` interface (decorator pattern).
 *
 * What is logged: method, tool name, duration, outcome and an error code.
 * What is NOT logged: tool arguments and results. They can contain personal
 * data, and they could contain secrets that users pasted into an issue.
 */
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from './logger.js';

/** `_meta` key that runTool() uses to pass a domain error code to this logger. */
export const ERROR_CODE_META_KEY = 'issue-tracker-mcp/errorCode';

type RequestId = string | number;

interface PendingRequest {
  method: string;
  tool?: string;
  startedAt: number;
}

export type CallOutcome = 'success' | 'tool_error' | 'rpc_error';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class LoggingTransport implements Transport {
  private readonly pending = new Map<RequestId, PendingRequest>();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport['onmessage'];

  constructor(
    private readonly inner: Transport,
    private readonly logger: Logger,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  async start(): Promise<void> {
    // Inbound: client → server. Record requests, then hand them to the server.
    this.inner.onmessage = (message, extra) => {
      this.recordRequest(message);
      this.onmessage?.(message, extra);
    };
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    await this.inner.start();
  }

  // Outbound: server → client. A response with a matching id completes a request.
  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.recordResponse(message);
    await this.inner.send(message, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  private recordRequest(message: JSONRPCMessage): void {
    if (!('method' in message) || !('id' in message)) return; // notifications have no id
    const params: unknown = message.params;
    const tool =
      message.method === 'tools/call' && isRecord(params) && typeof params.name === 'string'
        ? params.name
        : undefined;
    this.pending.set(message.id, {
      method: message.method,
      ...(tool !== undefined && { tool }),
      startedAt: this.clock(),
    });
  }

  private recordResponse(message: JSONRPCMessage): void {
    // Only responses; error responses to unparseable requests may have no id.
    if (!('id' in message) || 'method' in message || message.id === undefined) return;
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);

    const durationMs = Math.round((this.clock() - request.startedAt) * 100) / 100;
    let outcome: CallOutcome = 'success';
    let errorCode: string | undefined;

    if ('error' in message) {
      // JSON-RPC level failure (unknown method, malformed request, ...).
      outcome = 'rpc_error';
      errorCode = `RPC_${message.error.code}`;
    } else if ('result' in message && isRecord(message.result) && message.result.isError === true) {
      // Tool ran (or was rejected by the SDK) and reported an error result.
      outcome = 'tool_error';
      const meta = message.result._meta;
      const code = isRecord(meta) ? meta[ERROR_CODE_META_KEY] : undefined;
      // No code from runTool → the SDK rejected the call before our handler ran.
      errorCode = typeof code === 'string' ? code : 'INVALID_INPUT';
    }

    const fields = {
      event: request.tool ? 'tool_call' : 'mcp_request',
      method: request.method,
      ...(request.tool !== undefined && { tool: request.tool }),
      durationMs,
      outcome,
      ...(errorCode !== undefined && { errorCode }),
    };

    // Tool calls are the audit trail → info. Other chatter (list, ping) → debug.
    if (request.tool) {
      if (outcome === 'success') this.logger.info('tool call', fields);
      else this.logger.warn('tool call failed', fields);
    } else if (outcome === 'success') {
      this.logger.debug('mcp request', fields);
    } else {
      this.logger.warn('mcp request failed', fields);
    }
  }
}
