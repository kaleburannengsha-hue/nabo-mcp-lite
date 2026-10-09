#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { getExtensionPort, getHubPort, TOOL_TIMEOUT_MS, TOOLS } = require('./shared.cjs');

const extensionPort = getExtensionPort();
const hubPort = getHubPort();

let extWs = null;
let extensionConnected = false;
let extensionReqCounter = 0;
const pendingExtensionRequests = new Map();
const queue = [];
let queueBusy = false;

function log(message) {
  console.error(`[nabo-hub] ${message}`);
}

function startExtensionServer() {
  const wss = new WebSocketServer({ port: extensionPort, host: '127.0.0.1' });
  log(`Extension WS listening: ws://127.0.0.1:${extensionPort}`);

  wss.on('connection', ws => {
    if (extWs && extWs !== ws) {
      extWs.close();
    }
    extWs = ws;
    extensionConnected = true;
    log('Extension connected');

    ws.on('message', data => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === 'heartbeat') {
        ws.send(JSON.stringify({ type: 'heartbeat_ack', timestamp: msg.timestamp }));
        return;
      }

      const pending = pendingExtensionRequests.get(msg.id);
      if (!pending) return;
      pendingExtensionRequests.delete(msg.id);

      if (msg.type === 'tool_result') {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(msg.error || 'Unknown extension error'));
      }
    });

    ws.on('close', () => {
      if (extWs !== ws) return;
      extWs = null;
      extensionConnected = false;
      for (const [, pending] of pendingExtensionRequests) {
        pending.reject(new Error('Extension disconnected'));
      }
      pendingExtensionRequests.clear();
      log('Extension disconnected');
    });

    ws.on('error', () => {});
  });

  return wss;
}

function callExtension(tool, args) {
  if (!extensionConnected || !extWs) {
    return Promise.reject(new Error('Extension not connected'));
  }

  const id = `hub_req_${++extensionReqCounter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pendingExtensionRequests.has(id)) return;
      pendingExtensionRequests.delete(id);
      reject(new Error(`Tool ${tool} timed out after ${TOOL_TIMEOUT_MS / 1000}s`));
    }, TOOL_TIMEOUT_MS);

    pendingExtensionRequests.set(id, {
      resolve: result => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: error => {
        clearTimeout(timer);
        reject(error);
      },
    });

    extWs.send(JSON.stringify({ id, type: 'call_tool', tool, args }));
  });
}

function enqueueToolCall(tool, args) {
  return new Promise((resolve, reject) => {
    queue.push({ tool, args, resolve, reject });
    drainQueue();
  });
}

async function drainQueue() {
  if (queueBusy) return;
  queueBusy = true;
  try {
    while (queue.length) {
      const item = queue.shift();
      try {
        let result = await callExtension(item.tool, item.args);
        // screenshot + save:true → write JPEG to disk, return the path so the
        // base64 payload never has to travel into the model's context.
        if (
          item.tool === 'screenshot' &&
          item.args &&
          item.args.save &&
          result &&
          typeof result.screenshot === 'string'
        ) {
          const dir = process.env.NABO_SHOT_DIR || path.join(__dirname, '..', 'screenshots');
          fs.mkdirSync(dir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const file = path.join(dir, `shot-${stamp}.jpg`);
          fs.writeFileSync(file, Buffer.from(result.screenshot, 'base64'));
          result = { path: file, width: result.width, height: result.height, scale: result.scale, saved: true };
        }
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      }
    }
  } finally {
    queueBusy = false;
  }
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function startClientServer() {
  const wss = new WebSocketServer({ port: hubPort, host: '127.0.0.1' });
  log(`Client WS listening: ws://127.0.0.1:${hubPort}`);

  wss.on('connection', ws => {
    log('MCP client connected');

    ws.on('message', data => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        send(ws, { id: null, type: 'hub_error', error: 'Parse error' });
        return;
      }

      if (msg.type === 'ping') {
        send(ws, {
          id: msg.id,
          type: 'pong',
          extensionConnected,
          tools: TOOLS.length,
        });
        return;
      }

      if (msg.type !== 'call_tool' || !msg.tool) {
        send(ws, { id: msg.id, type: 'tool_error', error: 'Unknown hub message' });
        return;
      }

      enqueueToolCall(msg.tool, msg.args || {})
        .then(result => send(ws, { id: msg.id, type: 'tool_result', result }))
        .catch(err => send(ws, { id: msg.id, type: 'tool_error', error: err.message }));
    });

    ws.on('close', () => log('MCP client disconnected'));
    ws.on('error', () => {});
  });

  return wss;
}

function startHub() {
  const extensionServer = startExtensionServer();
  const clientServer = startClientServer();
  return { extensionServer, clientServer };
}

if (require.main === module) {
  startHub();
}

module.exports = { startHub };

