import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Process entry points are exercised end-to-end (MCP Inspector / Claude
      // Desktop), not by unit tests.
      exclude: ['src/stdio.ts', 'src/http.ts'],
      reporter: ['text', 'html'],
      // CI fails if coverage drops below these floors.
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
