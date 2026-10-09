#!/usr/bin/env node
'use strict';
// Call a hub tool directly over WS 9877 (bypasses the MCP client's cached tool list).
// Usage: node scripts/call-tool-direct.cjs <tool> [json-args]

const { WebSocket } = require('ws');
const { getHubPort } = require('../server/shared.cjs');

const tool = process.argv[2];
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
if (!tool) {
  console.error('usage: node call-tool-direct.cjs <tool> [json-args]');
  process.exit(1);
}

const ws = new WebSocket(`ws://127.0.0.1:${getHubPort()}`);
const t0 = Date.now();
const timeout = setTimeout(() => {
  console.error('TIMEOUT');
  process.exit(1);
}, 30000);

ws.on('open', () => ws.send(JSON.stringify({ id: 'direct_1', type: 'call_tool', tool, args })));
ws.on('message', data => {
  const msg = JSON.parse(data.toString());
  if (msg.id !== 'direct_1') return;
  clearTimeout(timeout);
  msg._elapsed_ms = Date.now() - t0;
  console.log(JSON.stringify(msg, null, 2));
  ws.close();
  process.exit(msg.type === 'tool_result' ? 0 : 1);
});
ws.on('error', err => {
  clearTimeout(timeout);
  console.error('WS error:', err.message);
  process.exit(1);
});
