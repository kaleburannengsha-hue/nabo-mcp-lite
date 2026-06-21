import { describe, expect, it, vi } from 'vitest';
import { installMcpWakeAlarm } from './wake-alarm';

describe('MCP wake alarm', () => {
  it('creates a 30-second alarm and reconnects only for that alarm', () => {
    let listener: ((alarm: { name: string }) => void) | undefined;
    const create = vi.fn();
    const ensureConnected = vi.fn();

    installMcpWakeAlarm({
      alarms: {
        create,
        onAlarm: {
          addListener: callback => {
            listener = callback;
          },
        },
      },
      ensureConnected,
    });

    expect(create).toHaveBeenCalledWith('nanobrowser-mcp-keepalive', { periodInMinutes: 0.5 });

    listener?.({ name: 'other-alarm' });
    expect(ensureConnected).not.toHaveBeenCalled();

    listener?.({ name: 'nanobrowser-mcp-keepalive' });
    expect(ensureConnected).toHaveBeenCalledOnce();
  });
});
