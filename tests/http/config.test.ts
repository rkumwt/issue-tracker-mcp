import { describe, expect, it } from 'vitest';
import { loadHttpConfig, MIN_API_KEY_LENGTH } from '../../src/config.js';
import { ConfigError } from '../../src/lib/errors.js';

const KEY = 'a'.repeat(MIN_API_KEY_LENGTH);

describe('loadHttpConfig', () => {
  it('applies safe defaults', () => {
    expect(loadHttpConfig({ MCP_API_KEY: KEY })).toEqual({
      port: 3000,
      host: '127.0.0.1',
      apiKey: KEY,
      rateLimitPerMinute: 60,
      maxBodyBytes: 102_400,
      allowedHosts: undefined,
      trustProxy: 0,
    });
  });

  it('coerces numbers and parses the host allow-list', () => {
    const config = loadHttpConfig({
      MCP_API_KEY: KEY,
      PORT: '8080',
      RATE_LIMIT_PER_MINUTE: '10',
      ALLOWED_HOSTS: ' mcp.example.com, ,localhost ',
      TRUST_PROXY: '1',
    });
    expect(config).toMatchObject({
      port: 8080,
      rateLimitPerMinute: 10,
      allowedHosts: ['mcp.example.com', 'localhost'],
      trustProxy: 1,
    });
  });

  it('requires an API key', () => {
    expect(() => loadHttpConfig({})).toThrow(ConfigError);
    expect(() => loadHttpConfig({})).toThrow(/MCP_API_KEY/);
  });

  it('rejects a short API key without echoing it', () => {
    const weak = 'hunter2-is-a-weak-key';
    let message = '';
    try {
      loadHttpConfig({ MCP_API_KEY: weak });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/at least 32 characters/);
    expect(message).not.toContain(weak);
  });

  it('rejects an invalid port', () => {
    expect(() => loadHttpConfig({ MCP_API_KEY: KEY, PORT: '70000' })).toThrow(/PORT/);
  });
});
