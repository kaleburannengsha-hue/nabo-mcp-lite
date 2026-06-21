import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const runtimeTestPath = fileURLToPath(new URL('./runtime-test.cjs', import.meta.url));

describe('runtime-test configuration', () => {
  it('uses the extension port and does not report server-only success', () => {
    const source = readFileSync(runtimeTestPath, 'utf8');

    expect(source).toContain("process.env.MCP_WS_PORT || '9876'");
    expect(source).not.toContain("MCP_WS_PORT: '9986'");
    expect(source).not.toContain('RUNTIME_TEST_OK (server only)');
  });

  it('loads ws through the package entry point instead of a pnpm version path', () => {
    const serverPath = fileURLToPath(
      new URL('../server/single-session-server.cjs', import.meta.url),
    );
    const source = readFileSync(serverPath, 'utf8');

    expect(source).toContain("require('ws')");
    expect(source).not.toContain('node_modules/.pnpm/ws@');
  });

  it('waits for the Chrome extension to reconnect before the first browser call', () => {
    const source = readFileSync(runtimeTestPath, 'utf8');

    expect(source).toContain('async function waitForExtension');
    expect(source).toContain("err.message.includes('Extension not connected')");
  });
});
