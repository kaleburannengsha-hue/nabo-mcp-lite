import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hubPath = fileURLToPath(new URL('../server/nabo-hub.cjs', import.meta.url));
const clientPath = fileURLToPath(new URL('../server/nabo-client.cjs', import.meta.url));
const legacyPath = fileURLToPath(new URL('../server/single-session-server.cjs', import.meta.url));
const hubRuntimeTestPath = fileURLToPath(new URL('./hub-runtime-test.cjs', import.meta.url));

describe('shared hub mode files', () => {
  it('provides a shared hub and stdio client entry point', () => {
    expect(existsSync(hubPath)).toBe(true);
    expect(existsSync(clientPath)).toBe(true);
    expect(existsSync(hubRuntimeTestPath)).toBe(true);
  });

  it('keeps the legacy server as a compatibility wrapper around hub mode', () => {
    const source = readFileSync(legacyPath, 'utf8');

    expect(source).toContain('nabo-hub.cjs');
    expect(source).toContain('nabo-client.cjs');
  });

  it('ensures the client connects to the hub instead of listening on the extension port', () => {
    const source = readFileSync(clientPath, 'utf8');

    expect(source).toContain('MCP_HUB_PORT');
    expect(source).not.toContain('new WebSocketServer');
  });
});
