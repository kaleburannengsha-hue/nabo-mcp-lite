#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { WebSocket } = require('ws');
const { getHubPort, TOOLS } = require('./shared.cjs');

// MCP_HUB_PORT controls the shared local Hub endpoint for all stdio clients.
const hubPort = getHubPort();
const hubUrl = `ws://127.0.0.1:${hubPort}`;
const pendingHubRequests = new Map();
let hubWs = null;
let hubReqCounter = 0;
let hubStartAttempted = false;
let hubConnectPromise = null;

function stdout(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function startHubProcess() {
  if (hubStartAttempted || process.env.NABO_CLIENT_AUTOSTART === '0') return;
  hubStartAttempted = true;

  const hubPath = path.resolve(__dirname, 'nabo-hub.cjs');
  const child = spawn(process.execPath, [hubPath], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}

function connectHub() {
  if (hubWs && hubWs.readyState === WebSocket.OPEN) return Promise.resolve(hubWs);
  if (hubConnectPromise) return hubConnectPromise;

  hubConnectPromise = new Promise((resolve, reject) => {
    const ws = new WebSocket(hubUrl);
    const timer = setTimeout(() => {
      ws.close();
      // 必须同时清除缓存的 promise：open/error 两个分支都会清，唯独超时分支漏了，
      // 导致该 client 进程此后永久拿到这个已 rejected 的 promise —— 既不重连，
      // 也再不会触发 startHubProcess（外部表现就是"每次都得手动启动 hub"）。
      hubConnectPromise = null;
      reject(new Error(`Hub connection timed out: ${hubUrl}`));
    }, 3000);

    ws.on('open', () => {
      clearTimeout(timer);
      hubWs = ws;
      hubConnectPromise = null;
      resolve(ws);
    });

    ws.on('message', data => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      const pending = pendingHubRequests.get(msg.id);
      if (!pending) return;
      pendingHubRequests.delete(msg.id);

      if (msg.type === 'tool_result' || msg.type === 'pong') {
        pending.resolve(msg);
      } else {
        pending.reject(new Error(msg.error || 'Unknown hub error'));
      }
    });

    ws.on('close', () => {
      if (hubWs === ws) hubWs = null;
      // 连接关闭后清掉缓存的 promise，让下一次调用重新建连（并有机会重新拉起 hub）。
      hubConnectPromise = null;
      for (const [, pending] of pendingHubRequests) {
        pending.reject(new Error('Hub disconnected'));
      }
      pendingHubRequests.clear();
    });

    ws.on('error', err => {
      clearTimeout(timer);
      hubConnectPromise = null;
      reject(err);
    });
  });

  return hubConnectPromise;
}

async function ensureHub() {
  try {
    return await connectHub();
  } catch (firstError) {
    startHubProcess();
    // 冷启动时 hub（Node 加载 ws + 杀软扫描）常在 500ms 内还没开始监听，
    // 单次 sleep 后重连必然失败。改为轮询约 4 秒。
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 400));
      try {
        return await connectHub();
      } catch {
        // hub 还没起来，继续重试
      }
    }
    throw firstError;
  }
}

async function sendToHub(type, payload = {}) {
  const ws = await ensureHub();
  const id = `client_req_${++hubReqCounter}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHubRequests.delete(id);
      reject(new Error(`Hub request ${type} timed out`));
    }, 65_000);

    pendingHubRequests.set(id, {
      resolve: value => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: error => {
        clearTimeout(timer);
        reject(error);
      },
    });

    ws.send(JSON.stringify({ id, type, ...payload }));
  });
}

async function handleMCP(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    stdout({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'nabo-mcp-lite', version: '0.1.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    stdout({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    if (!TOOLS.find(tool => tool.name === toolName)) {
      stdout({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } });
      return;
    }

    try {
      const response = await sendToHub('call_tool', { tool: toolName, args: toolArgs });
      stdout({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(response.result, null, 2) }] },
      });
    } catch (err) {
      stdout({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
    }
    return;
  }

  stdout({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
}

function runClient() {
  process.stdin.on('data', buffer => {
    const lines = buffer
      .toString()
      .split('\n')
      .filter(line => line.trim());

    for (const line of lines) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        stdout({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      void handleMCP(msg);
    }
  });
}

if (require.main === module) {
  runClient();
}

module.exports = { runClient };
