#!/usr/bin/env node
// scripts/hub-runtime-test.cjs — verifies two stdio MCP clients share one Hub.
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const HUB_PATH = path.resolve(__dirname, '..', 'server', 'nabo-hub.cjs');
const CLIENT_PATH = path.resolve(__dirname, '..', 'server', 'nabo-client.cjs');
const IDLE_WAIT_MS = parseInt(process.env.IDLE_WAIT_MS || '2000', 10);
const WS_PORT = parseInt(process.env.MCP_WS_PORT || '9876', 10);
const HUB_PORT = parseInt(process.env.MCP_HUB_PORT || '9877', 10);
const TIMEOUT_MS = 120000;

function spawnNode(script, name) {
  const proc = spawn(process.execPath, [script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MCP_WS_PORT: String(WS_PORT),
      MCP_HUB_PORT: String(HUB_PORT),
      NABO_CLIENT_AUTOSTART: '0',
    },
  });
  proc.name = name;
  proc.reqId = 0;
  proc.pending = new Map();
  proc.stdoutBuffer = '';
  proc.stdout.on('data', chunk => {
    proc.stdoutBuffer += chunk.toString();
    const lines = proc.stdoutBuffer.split('\n');
    proc.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) collectOutput(proc, line);
    }
  });
  proc.stderr.on('data', chunk => {
    const msg = chunk.toString().trim();
    if (msg) console.error(`[${name}]`, msg);
  });
  return proc;
}

function collectOutput(proc, line) {
  try {
    const msg = JSON.parse(line);
    if (msg.id && proc.pending.has(msg.id)) {
      const pending = proc.pending.get(msg.id);
      proc.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
    }
  } catch {
    // Ignore non-JSON output.
  }
}

function send(proc, method, params) {
  const id = String(++proc.reqId);
  const msg = { jsonrpc: '2.0', id, method };
  if (params) msg.params = params;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${proc.name} timeout: ${method}`)), 30000);
    proc.pending.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify(msg) + '\n');
  });
}

async function initializeClient(proc) {
  const initResult = await send(proc, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: proc.name, version: '1.0.0' },
  });
  if (initResult.serverInfo?.name !== 'nabo-mcp-lite') {
    throw new Error(`${proc.name} unexpected serverInfo: ${JSON.stringify(initResult.serverInfo)}`);
  }
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
}

async function waitForExtension(proc, attempts = 10, delayMs = 1000) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await send(proc, 'tools/call', {
        name: 'list_tabs',
        arguments: {},
      });
    } catch (err) {
      if (!err.message.includes('Extension not connected') || attempt === attempts) {
        throw err;
      }
      console.log(`   Waiting for extension connection (${attempt}/${attempts})...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('Extension did not connect');
}

async function run() {
  console.log('=== Nabo MCP Lite Shared Hub Runtime Test ===\n');
  console.log(`Hub port: ${HUB_PORT}; extension port: ${WS_PORT}`);

  const hub = spawnNode(HUB_PATH, 'hub');
  await new Promise(resolve => setTimeout(resolve, 700));

  const clientA = spawnNode(CLIENT_PATH, 'client-a');
  const clientB = spawnNode(CLIENT_PATH, 'client-b');
  const timer = setTimeout(() => {
    clientA.kill();
    clientB.kill();
    hub.kill();
  }, TIMEOUT_MS);

  try {
    console.log('1. Initializing two stdio clients...');
    await Promise.all([initializeClient(clientA), initializeClient(clientB)]);
    console.log('   CLIENTS_INITIALIZED_OK');

    console.log('2. Listing tools from both clients...');
    const [toolsA, toolsB] = await Promise.all([
      send(clientA, 'tools/list', {}),
      send(clientB, 'tools/list', {}),
    ]);
    if ((toolsA.tools || []).length !== 14 || (toolsB.tools || []).length !== 14) {
      throw new Error('Expected both clients to see 14 tools');
    }
    console.log('   TOOLS_LIST_OK');

    console.log('3. Waiting for extension through client A...');
    const tabsResultA = await waitForExtension(clientA);
    const tabsA = JSON.parse(tabsResultA.content[0].text);
    console.log('   CLIENT_A_FIRST_CALL_OK —', tabsA.length, 'tabs');

    console.log('4. Calling list_tabs through both clients concurrently...');
    const [tabsResultA2, tabsResultB] = await Promise.all([
      send(clientA, 'tools/call', { name: 'list_tabs', arguments: {} }),
      send(clientB, 'tools/call', { name: 'list_tabs', arguments: {} }),
    ]);
    const tabsA2 = JSON.parse(tabsResultA2.content[0].text);
    const tabsB = JSON.parse(tabsResultB.content[0].text);
    console.log('   CLIENT_A_SECOND_CALL_OK —', tabsA2.length, 'tabs');
    console.log('   CLIENT_B_FIRST_CALL_OK —', tabsB.length, 'tabs');

    console.log(`5. Waiting ${IDLE_WAIT_MS / 1000}s and calling again through client B...`);
    await new Promise(resolve => setTimeout(resolve, IDLE_WAIT_MS));
    const tabsResultB2 = await send(clientB, 'tools/call', { name: 'list_tabs', arguments: {} });
    const tabsB2 = JSON.parse(tabsResultB2.content[0].text);
    console.log('   CLIENT_B_SECOND_CALL_OK —', tabsB2.length, 'tabs');

    console.log('\n=== HUB_RUNTIME_TEST_OK ===');
  } finally {
    clearTimeout(timer);
    clientA.kill();
    clientB.kill();
    hub.kill();
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

run().catch(err => {
  console.error('FATAL:', err.message);
  process.exitCode = 1;
});
