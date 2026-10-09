#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const hub = spawn(process.execPath, [path.resolve('server/nabo-hub.cjs')], {
  cwd: process.cwd(),
  env: { ...process.env, NABO_CLIENT_AUTOSTART: '0' },
  stdio: ['ignore', 'ignore', 'pipe'],
});

const cp = spawn(process.execPath, [path.resolve('server/nabo-client.cjs')], {
  cwd: process.cwd(),
  env: { ...process.env, NABO_CLIENT_AUTOSTART: '0' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
let nextId = 0;
const pending = new Map();

function send(method, params, timeout = 60000) {
  const id = String(++nextId);
  cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeout);
    pending.set(id, { resolve, reject, timer });
  });
}

async function callTool(name, args = {}) {
  return send('tools/call', { name, arguments: args });
}

async function retryTool(name, args = {}, attempts = 15) {
  let last;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await callTool(name, args);
    } catch (err) {
      last = err;
      console.log('RETRY', i, name, err.message);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw last;
}

cp.stdout.on('data', chunk => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const item = pending.get(msg.id);
    if (!item) continue;
    clearTimeout(item.timer);
    pending.delete(msg.id);
    if (msg.error) item.reject(new Error(msg.error.message));
    else item.resolve(msg.result);
  }
});

cp.stderr.on('data', chunk => process.stderr.write('[server] ' + chunk.toString()));
hub.stderr.on('data', chunk => process.stderr.write('[hub] ' + chunk.toString()));

async function main() {
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cdp-page-test', version: '0' },
  });
  cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  const tabsResult = await retryTool('list_tabs');
  const tabs = JSON.parse(tabsResult.content[0].text);
  console.log('TABS', JSON.stringify(tabs, null, 2));

  const target =
    tabs.find(t => t.active && /^https?:/.test(t.url || '')) ||
    tabs.find(t => /test|测试|exam|考试|question|题/i.test((t.url || '') + ' ' + (t.title || ''))) ||
    tabs.find(t => /^https?:/.test(t.url || ''));

  if (!target) throw new Error('no http(s) target tab found');
  console.log('TARGET', JSON.stringify(target, null, 2));

  await callTool('switch_tab', { tab_id: target.id });
  await new Promise(resolve => setTimeout(resolve, 800));

  const probes = [
    ['ONE_PLUS_ONE', '1 + 1'],
    ['DOCUMENT_TYPE', 'typeof document'],
    ['LOCATION', 'location.href'],
    ['TITLE', 'document.title'],
    ['BODY_TEXT_LEN', 'document.body ? document.body.innerText.length : -1'],
    ['QUESTION_BOX_COUNT', "document.querySelectorAll('.question_box').length"],
    ['QUESTION_18', "document.querySelectorAll('.question_box')[17]?.innerText.slice(0,120) ?? null"],
    ['QUESTION_80', "document.querySelectorAll('.question_box')[79]?.innerText.slice(0,120) ?? null"],
  ];

  for (const [name, code] of probes) {
    try {
      const result = await callTool('execute_script', { code });
      console.log(name, result.content[0].text);
    } catch (err) {
      console.log(`${name}_ERROR`, err.message);
    }
  }
}

main()
  .catch(err => {
    console.error('TEST_ERROR', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    cp.kill();
    hub.kill();
  });
