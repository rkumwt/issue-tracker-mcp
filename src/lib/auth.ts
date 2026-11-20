/**
 * API-key authentication for the HTTP transport.
 *
 * Clients send `Authorization: Bearer <key>`. The expected key comes from the
 * MCP_API_KEY environment variable locally and from SSM Parameter Store on
 * AWS (phase 5); it is never hard-coded or logged.
 *
 * Security details worth knowing:
 *  - Constant-time comparison. A naive `a === b` returns as soon as a character
 *    differs, so response timing could leak how much of a guess was right.
 *    Hashing both sides to SHA-256 first gives equal-length buffers, which
 *    `timingSafeEqual` requires, and hides the key's length.
 *  - Failures return 401 with `WWW-Authenticate: Bearer` (RFC 6750) and a
 *    JSON-RPC-shaped error body, so MCP clients can show a sensible message.
 *  - The same message is used for "missing" and "wrong", so callers can't
 *    probe which one they hit.
 *
 * A single shared key is the simplest real protection for a personal or team
 * server. Multi-user production would use OAuth 2.1, which MCP specifies for
 * HTTP transports; see the README.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from './logger.js';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time string equality. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/** Extract the token from "Bearer <token>" (scheme is case-insensitive), or undefined. */
export function parseBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

export function bearerAuth(expectedKey: string, logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = parseBearerToken(req.headers.authorization);
    if (token !== undefined && safeEqual(token, expectedKey)) {
      next();
      return;
    }

    // Log THAT it failed and why, never the token itself. Prefer the
    // per-request logger (carries the requestId) when one is available.
    const log = (res.locals.logger as Logger | undefined) ?? logger;
    log.warn('authentication failed', {
      event: 'auth_failed',
      reason: token === undefined ? 'missing_or_malformed' : 'invalid_key',
      ip: req.ip,
    });
    res
      .status(401)
      .set('WWW-Authenticate', 'Bearer realm="issue-tracker-mcp"')
      .json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: missing or invalid API key' },
        id: null,
      });
  };
}
