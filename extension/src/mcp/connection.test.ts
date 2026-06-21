import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpConnectionManager, type McpSocket } from './connection';

class FakeSocket implements McpSocket {
  readyState = 0;
  sent: string[] = [];
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

describe('MCP connection lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('creates only one socket while connecting or open', () => {
    const sockets: FakeSocket[] = [];
    const manager = createMcpConnectionManager({
      url: 'ws://127.0.0.1:9876',
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onMessage: vi.fn(),
    });

    manager.ensureConnected();
    manager.ensureConnected();
    sockets[0].open();
    manager.ensureConnected();

    expect(sockets).toHaveLength(1);
  });

  it('sends heartbeats frequently enough to keep an MV3 worker active', () => {
    const socket = new FakeSocket();
    const manager = createMcpConnectionManager({
      url: 'ws://127.0.0.1:9876',
      createSocket: () => socket,
      onMessage: vi.fn(),
      heartbeatMs: 20_000,
    });

    manager.ensureConnected();
    socket.open();
    vi.advanceTimersByTime(20_000);

    expect(JSON.parse(socket.sent[0])).toMatchObject({ type: 'heartbeat' });
  });

  it('keeps the socket open when heartbeat acknowledgements arrive', () => {
    const socket = new FakeSocket();
    const manager = createMcpConnectionManager({
      url: 'ws://127.0.0.1:9876',
      createSocket: () => socket,
      onMessage: vi.fn(),
      heartbeatMs: 20_000,
    });

    manager.ensureConnected();
    socket.open();
    vi.advanceTimersByTime(20_000);
    socket.receive({ type: 'heartbeat_ack' });
    vi.advanceTimersByTime(20_000);

    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(2);
  });

  it('closes a stale socket when a heartbeat is not acknowledged', () => {
    const socket = new FakeSocket();
    const manager = createMcpConnectionManager({
      url: 'ws://127.0.0.1:9876',
      createSocket: () => socket,
      onMessage: vi.fn(),
      heartbeatMs: 20_000,
    });

    manager.ensureConnected();
    socket.open();
    vi.advanceTimersByTime(40_000);

    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('reconnects after a closed socket', () => {
    const sockets: FakeSocket[] = [];
    const manager = createMcpConnectionManager({
      url: 'ws://127.0.0.1:9876',
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onMessage: vi.fn(),
      reconnectMs: 2_000,
    });

    manager.ensureConnected();
    sockets[0].open();
    sockets[0].close();
    vi.advanceTimersByTime(2_000);

    expect(sockets).toHaveLength(2);
  });

  it('replies to tool messages through the existing socket', () => {
    const socket = new FakeSocket();
    const manager = createMcpConnectionManager({
      url: 'ws://127.0.0.1:9876',
      createSocket: () => socket,
      onMessage: (message, reply) => {
        expect(message).toEqual({ id: 'req_1', type: 'call_tool' });
        reply({ id: 'req_1', type: 'tool_result', result: { success: true } });
      },
    });

    manager.ensureConnected();
    socket.open();
    socket.receive({ id: 'req_1', type: 'call_tool' });

    expect(JSON.parse(socket.sent[0])).toEqual({
      id: 'req_1',
      type: 'tool_result',
      result: { success: true },
    });
  });
});
