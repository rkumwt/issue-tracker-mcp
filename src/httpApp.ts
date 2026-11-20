/**
 * Express app that serves MCP over Streamable HTTP.
 *
 * Kept separate from src/http.ts (which only calls `listen()`), so tests can
 * drive it with supertest and the Lambda handler (phase 5) can reuse it.
 *
 * STATELESS MODE: every POST /mcp creates a fresh McpServer + transport, and
 * nothing about the client is remembered between requests (no session id).
 * This is what makes the server Lambda-friendly: any instance can answer any
 * request, and instances can be created or destroyed at will. The cost is that
 * server-initiated messages (notifications, sampling) are not available,
 * which this server does not need.
 *
 * JSON responses instead of SSE: `enableJsonResponse` makes each POST return
 * one plain JSON body instead of a Server-Sent Events stream. API Gateway HTTP
 * API + Lambda buffers responses anyway, so streaming would gain nothing.
 *
 * Middleware order (each step protects the next):
 *   host check → request id + access log → rate limit → API key → JSON body
 *   (size-limited) → MCP handler
 * Rate limiting runs BEFORE auth so API-key guessing is throttled too, and
 * auth runs BEFORE body parsing so unauthenticated callers can't make us parse
 * large payloads.
 */
import { randomUUID } from 'node:crypto';
import {
  hostHeaderValidation,
  localhostHostValidation,
} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { rateLimit } from 'express-rate-limit';
import type { IssueRepository } from './db/IssueRepository.js';
import { bearerAuth } from './lib/auth.js';
import type { Logger } from './lib/logger.js';
import { LoggingTransport } from './lib/loggingTransport.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';

export interface HttpAppOptions {
  repo: IssueRepository;
  logger: Logger;
  apiKey: string;
  rateLimitPerMinute: number;
  maxBodyBytes: number;
  /** Host header allow-list. If unset and `host` is a loopback address, localhost-only is enforced. */
  allowedHosts?: string[] | undefined;
  /** Address the server listens on; used to pick the default host check. */
  host?: string;
  /** Number of trusted reverse-proxy hops (for the real client IP). */
  trustProxy?: number;
  now?: () => Date;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const REQUEST_ID = /^[\w.-]{1,64}$/;

/** JSON-RPC error envelope, used for every HTTP-level error response. */
function rpcError(code: number, message: string) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/** Per-request id + logger, and one access-log line when the response finishes. */
function requestLogging(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    const startedAt = performance.now();
    const requestLogger = logger.child({ requestId });

    res.locals.logger = requestLogger;
    res.setHeader('x-request-id', requestId);
    res.on('finish', () => {
      const fields = {
        event: 'http_request',
        method: req.method,
        path: req.path, // path only: query strings could carry data
        status: res.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      };
      if (req.path === '/health') requestLogger.debug('http request', fields);
      else if (res.statusCode >= 500) requestLogger.error('http request', fields);
      else requestLogger.info('http request', fields);
    });
    next();
  };
}

function requestLogger(res: Response, fallback: Logger): Logger {
  return (res.locals.logger as Logger | undefined) ?? fallback;
}

export function createHttpApp(options: HttpAppOptions): Express {
  const { repo, logger, now } = options;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', options.trustProxy ?? 0);

  // DNS-rebinding protection: reject requests whose Host header we don't expect.
  if (options.allowedHosts) {
    app.use(hostHeaderValidation(options.allowedHosts));
  } else if (LOOPBACK_HOSTS.has(options.host ?? '127.0.0.1')) {
    app.use(localhostHostValidation());
  }

  app.use(requestLogging(logger));

  // Unauthenticated liveness probe (no data, no DB access).
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', name: SERVER_NAME, version: SERVER_VERSION });
  });

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: options.rateLimitPerMinute,
    standardHeaders: 'draft-8', // RateLimit / RateLimit-Policy response headers
    legacyHeaders: false,
    handler: (req, res) => {
      requestLogger(res, logger).warn('rate limit exceeded', { event: 'rate_limited', ip: req.ip });
      res.status(429).json(rpcError(-32000, 'Too many requests, slow down'));
    },
  });

  const auth = bearerAuth(options.apiKey, logger);
  const jsonBody = express.json({ limit: options.maxBodyBytes });

  app.post('/mcp', limiter, auth, jsonBody, async (req: Request, res: Response) => {
    const reqLogger = requestLogger(res, logger);
    const server = createServer({ repo, logger: reqLogger, ...(now && { now }) });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });

    // Free per-request resources once the response is done (or the client hangs up).
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(new LoggingTransport(transport, reqLogger));
    await transport.handleRequest(req, res, req.body);
  });

  // In stateless mode there is no session to stream to (GET) or end (DELETE).
  const methodNotAllowed: RequestHandler = (_req, res) => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json(rpcError(-32000, 'Method not allowed: this server is stateless, use POST /mcp'));
  };
  app.get('/mcp', limiter, auth, methodNotAllowed);
  app.delete('/mcp', limiter, auth, methodNotAllowed);

  app.use((_req, res) => {
    res.status(404).json(rpcError(-32601, 'Not found'));
  });

  // Central error handler: body-parser errors become proper 4xx JSON-RPC errors;
  // anything else is logged and returned as a generic 500.
  const errorHandler: ErrorRequestHandler = (
    err: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    const type = (err as { type?: unknown }).type;
    if (type === 'entity.too.large') {
      res
        .status(413)
        .json(rpcError(-32600, `Request body too large (max ${options.maxBodyBytes} bytes)`));
      return;
    }
    if (type === 'entity.parse.failed') {
      res.status(400).json(rpcError(-32700, 'Parse error: invalid JSON'));
      return;
    }
    requestLogger(res, logger).error('unhandled http error', { err });
    if (!res.headersSent) res.status(500).json(rpcError(-32603, 'Internal server error'));
  };
  app.use(errorHandler);

  return app;
}
