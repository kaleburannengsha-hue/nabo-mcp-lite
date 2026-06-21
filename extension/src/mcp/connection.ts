export interface McpSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

interface McpConnectionOptions {
  url: string;
  onMessage(message: unknown, reply: (message: unknown) => void): void | Promise<void>;
  createSocket?: (url: string) => McpSocket;
  heartbeatMs?: number;
  reconnectMs?: number;
  logger?: {
    info(message: string): void;
    warning(message: string): void;
  };
}

export interface McpConnectionManager {
  ensureConnected(): void;
  dispose(): void;
}

const CONNECTING = 0;
const OPEN = 1;

export function createMcpConnectionManager({
  url,
  onMessage,
  createSocket = socketUrl => new WebSocket(socketUrl) as unknown as McpSocket,
  heartbeatMs = 20_000,
  reconnectMs = 2_000,
  logger,
}: McpConnectionOptions): McpConnectionManager {
  let socket: McpSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let awaitingHeartbeat = false;
  let disposed = false;

  const clearHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    awaitingHeartbeat = false;
  };

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensureConnected();
    }, reconnectMs);
  };

  const startHeartbeat = () => {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!socket || socket.readyState !== OPEN) return;
      if (awaitingHeartbeat) {
        logger?.warning('MCP bridge: heartbeat acknowledgement timed out');
        socket.close();
        return;
      }
      awaitingHeartbeat = true;
      socket.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
    }, heartbeatMs);
  };

  const connect = () => {
    if (disposed || (socket && (socket.readyState === CONNECTING || socket.readyState === OPEN))) return;

    try {
      socket = createSocket(url);
    } catch {
      socket = null;
      scheduleReconnect();
      return;
    }

    const connectingSocket = socket;
    connectingSocket.onopen = () => {
      if (socket !== connectingSocket) return;
      logger?.info('MCP bridge: WebSocket connected to MCP server');
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      startHeartbeat();
    };
    connectingSocket.onmessage = event => {
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'heartbeat_ack') {
        awaitingHeartbeat = false;
        return;
      }

      void onMessage(message, response => {
        if (socket === connectingSocket && connectingSocket.readyState === OPEN) {
          connectingSocket.send(JSON.stringify(response));
        }
      });
    };
    connectingSocket.onclose = () => {
      if (socket !== connectingSocket) return;
      logger?.info('MCP bridge: WebSocket disconnected');
      clearHeartbeat();
      socket = null;
      scheduleReconnect();
    };
    connectingSocket.onerror = () => {
      connectingSocket.close();
    };
  };

  const ensureConnected = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connect();
  };

  return {
    ensureConnected,
    dispose() {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearHeartbeat();
      socket?.close();
      socket = null;
    },
  };
}
