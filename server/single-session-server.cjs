#!/usr/bin/env node
// single-session-server.cjs — 单Session MCP server + WebSocket bridge for Nabo MCP Lite extension
'use strict';

const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const WSS_PROXY_PORT = Number(process.env.MCP_WS_PORT || 9876);

// ── Tool definitions ──
const TOOLS = [
  {
    name: 'list_tabs',
    description: 'List all open browser tabs with ID, title, URL, and active state',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_dom',
    description: 'Scan the current page and return all interactive elements with their indices and page text',
    inputSchema: {
      type: 'object',
      properties: { use_vision: { type: 'boolean', description: 'Include screenshot (default: false)' } },
      required: [],
    },
  },
  {
    name: 'get_page_text',
    description: 'Get up to 50,000 characters of HTML from the current page, with truncation metadata',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot of the current page (returns base64 JPEG)',
    inputSchema: {
      type: 'object',
      properties: { full_page: { type: 'boolean', description: 'Capture full page (default: false)' } },
      required: [],
    },
  },
  {
    name: 'click_element',
    description: 'Click an element by its highlight index',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'integer', description: 'Element highlight index from get_dom output' } },
      required: ['index'],
    },
  },
  {
    name: 'input_text',
    description: 'Type text into an input element by its highlight index',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: 'Element index from get_dom' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['index', 'text'],
    },
  },
  {
    name: 'navigate',
    description: 'Navigate the current tab to a URL',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to navigate to' } },
      required: ['url'],
    },
  },
  {
    name: 'switch_tab',
    description: 'Switch to a specific tab by its ID',
    inputSchema: {
      type: 'object',
      properties: { tab_id: { type: 'integer', description: 'Tab ID from list_tabs' } },
      required: ['tab_id'],
    },
  },
  {
    name: 'open_tab',
    description: 'Open a new tab with the given URL',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to open in new tab' } },
      required: ['url'],
    },
  },
  {
    name: 'close_tab',
    description: 'Close a tab by its ID',
    inputSchema: {
      type: 'object',
      properties: { tab_id: { type: 'integer', description: 'Tab ID from list_tabs' } },
      required: ['tab_id'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page to a vertical percentage (0=top, 100=bottom)',
    inputSchema: {
      type: 'object',
      properties: { y_percent: { type: 'integer', description: 'Vertical scroll percentage (0-100)' } },
      required: ['y_percent'],
    },
  },
  {
    name: 'select_option',
    description: 'Select an option from a dropdown by element index and option text',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: 'Dropdown element index from get_dom' },
        text: { type: 'string', description: 'Visible text of the option to select' },
      },
      required: ['index', 'text'],
    },
  },
  {
    name: 'send_keys',
    description: 'Send keyboard keys (Enter, Escape, Tab, Control+A, etc.)',
    inputSchema: {
      type: 'object',
      properties: { keys: { type: 'string', description: 'Keys to send. Supports modifiers like Control+A' } },
      required: ['keys'],
    },
  },
  {
    name: 'execute_script',
    description: 'Execute arbitrary JavaScript in the current page and return the result',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'JavaScript code to execute' } },
      required: ['code'],
    },
  },
];

// ── State ──
let extWs = null;
let pendingRequests = new Map();
let reqCounter = 0;
let connected = false;

// ── Server for Extension ──
function startExtensionServer() {
  const wss = new WebSocketServer({ port: WSS_PROXY_PORT, host: '127.0.0.1' });
  console.error(`[mcp-server] Extension WS server on ws://127.0.0.1:${WSS_PROXY_PORT}`);

  wss.on('connection', ws => {
    extWs = ws;
    connected = true;
    console.error('[mcp-server] Extension connected');

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
      const pending = pendingRequests.get(msg.id);
      if (pending) {
        pendingRequests.delete(msg.id);
        if (msg.type === 'tool_result') {
          pending.resolve(msg.result);
        } else {
          pending.reject(new Error(msg.error || 'Unknown error'));
        }
      }
    });

    ws.on('close', () => {
      connected = false;
      extWs = null;
      for (const [, p] of pendingRequests) p.reject(new Error('Extension disconnected'));
      pendingRequests.clear();
      console.error('[mcp-server] Extension disconnected');
    });

    ws.on('error', () => {});
  });
}

async function sendToExtension(tool, args) {
  if (!connected) throw new Error('Extension not connected');
  const id = `req_${++reqCounter}`;
  return new Promise((resolve, reject) => {
    if (!extWs) {
      reject(new Error('No extension socket'));
      return;
    }
    pendingRequests.set(id, { resolve, reject });
    extWs.send(JSON.stringify({ id, type: 'call_tool', tool, args }));
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`Tool ${tool} timed out after 60s`));
      }
    }, 60000);
  });
}

// ── MCP stdio ──
const stdout = msg => process.stdout.write(JSON.stringify(msg) + '\n');

process.stdin.on('data', buffer => {
  const lines = buffer
    .toString()
    .split('\n')
    .filter(l => l.trim());
  for (const line of lines) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      stdout({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    handleMCP(msg);
  }
});

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
    const toolName = params.name;
    const toolArgs = params.arguments || {};
    if (!TOOLS.find(t => t.name === toolName)) {
      stdout({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } });
      return;
    }
    try {
      const result = await sendToExtension(toolName, toolArgs);
      stdout({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    } catch (err) {
      stdout({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
    }
    return;
  }
  stdout({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
}

// ── Start ──
startExtensionServer();
