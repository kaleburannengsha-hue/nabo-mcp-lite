#!/usr/bin/env node
// scripts/runtime-test.cjs — shared Hub baseline verification.
// Usage: node scripts/runtime-test.cjs
//
// This test starts the shared Hub plus one stdio MCP client. The Chrome
// extension must be loaded from dist/ for browser-dependent tools to succeed.
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const HUB_PATH = path.resolve(__dirname, '..', 'server', 'nabo-hub.cjs');
const CLIENT_PATH = path.resolve(__dirname, '..', 'server', 'nabo-client.cjs');
const IDLE_WAIT_MS = parseInt(process.env.IDLE_WAIT_MS || '45000', 10);
const WS_PORT = parseInt(process.env.MCP_WS_PORT || '9876', 10);
const HUB_PORT = parseInt(process.env.MCP_HUB_PORT || '9877', 10);
const TIMEOUT_MS = 120000;

let reqId = 0;

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
  proc.pending = new Map();
  return proc;
}

function send(proc, method, params) {
  const id = String(++reqId);
  const msg = { jsonrpc: '2.0', id, method };
  if (params) msg.params = params;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 30000);
    proc.pending.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify(msg) + '\n');
  });
}

function collectOutput(proc, line) {
  try {
    const msg = JSON.parse(line);
    if (msg.id && proc.pending.has(msg.id)) {
      const p = proc.pending.get(msg.id);
      clearTimeout(p.timer);
      proc.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
    }
  } catch {
    // not JSON or notification, ignore
  }
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
  console.log('=== Nabo MCP Lite Runtime Test ===\n');
  console.log(`Hub port: ${HUB_PORT}; extension port: ${WS_PORT}`);

  const hub = spawnNode(HUB_PATH, 'hub');
  hub.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) console.error('[hub]', msg);
  });

  await new Promise(r => setTimeout(r, 700));

  const proc = spawnNode(CLIENT_PATH, 'client');
  let buffer = '';
  proc.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) collectOutput(proc, line);
    }
  });
  proc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) console.error('[client]', msg);
  });

  const timer = setTimeout(() => {
    proc.kill();
    hub.kill();
  }, TIMEOUT_MS);

  try {
    console.log('1. Sending initialize...');
    const initResult = await send(proc, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'runtime-test', version: '1.0.0' },
    });
    if (initResult.serverInfo?.name === 'nabo-mcp-lite') {
      console.log('   PASS: Server identified as nabo-mcp-lite v' + initResult.serverInfo.version);
    } else {
      throw new Error('Unexpected serverInfo: ' + JSON.stringify(initResult.serverInfo));
    }

    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    console.log('2. Sending tools/list...');
    const toolsResult = await send(proc, 'tools/list', {});
    const toolNames = (toolsResult.tools || []).map(t => t.name).sort();
    const expectedTools = [
      'click_element', 'close_tab', 'execute_script', 'get_dom',
      'get_page_text', 'input_text', 'list_tabs', 'navigate',
      'open_tab', 'screenshot', 'scroll', 'select_option',
      'send_keys', 'switch_tab',
    ].sort();
    if (JSON.stringify(toolNames) === JSON.stringify(expectedTools)) {
      console.log('   PASS: All 14 tools registered');
    } else {
      const missing = expectedTools.filter(t => !toolNames.includes(t));
      const extra = toolNames.filter(t => !expectedTools.includes(t));
      console.log('   WARN: Tool mismatch. Missing:', missing, 'Extra:', extra);
    }

    console.log(`3. Sending list_tabs through Hub and extension on port ${WS_PORT}...`);
    const tabsResult = await waitForExtension(proc);
    const text = JSON.parse(tabsResult.content[0].text);
    console.log('   FIRST_CALL_OK —', text.length, 'tabs');

    const testTab =
      text.find(tab => tab.active && /^https?:\/\//.test(tab.url || '')) ||
      text.find(tab => /^https?:\/\//.test(tab.url || ''));
    if (!testTab) {
      throw new Error('No regular http(s) tab is available for browser tool verification');
    }
    if (!testTab.active) {
      await send(proc, 'tools/call', {
        name: 'switch_tab',
        arguments: { tab_id: testTab.id },
      });
    }

    console.log('4. Sending get_dom...');
    const domResult = await send(proc, 'tools/call', {
      name: 'get_dom',
      arguments: {},
    });
    const domText = JSON.parse(domResult.content[0].text);
    console.log('   DOM_OK — url:', domText.url, 'elements:', domText.selectorMapSize);

    console.log('5. Sending get_page_text...');
    const pageTextResult = await send(proc, 'tools/call', {
      name: 'get_page_text',
      arguments: {},
    });
    const pageText = JSON.parse(pageTextResult.content[0].text);
    if (typeof pageText.truncated !== 'boolean' || typeof pageText.originalLength !== 'number') {
      throw new Error('Loaded extension is stale: get_page_text truncation metadata is missing');
    }
    if (pageText.content.length > 50000) {
      throw new Error(`get_page_text returned ${pageText.content.length} characters; expected at most 50000`);
    }
    console.log(
      '   PAGE_TEXT_OK — returned:',
      pageText.content.length,
      'original:',
      pageText.originalLength,
      'truncated:',
      pageText.truncated,
    );

    console.log('6. Sending execute_script...');
    const scriptCallResult = await send(proc, 'tools/call', {
      name: 'execute_script',
      arguments: { code: '1 + 1' },
    });
    const scriptResult = JSON.parse(scriptCallResult.content[0].text);
    if (scriptResult.mode !== 'cdp') {
      throw new Error('Loaded extension is stale: execute_script did not use CDP mode');
    }
    if (scriptResult.result !== 2) {
      throw new Error(`execute_script returned ${scriptResult.result}; expected 2`);
    }
    console.log('   EXECUTE_SCRIPT_OK — mode:', scriptResult.mode, 'result:', scriptResult.result);

    console.log(`7. Waiting ${IDLE_WAIT_MS / 1000}s for idle period...`);
    await new Promise(r => setTimeout(r, IDLE_WAIT_MS));

    console.log('8. Sending list_tabs after idle...');
    const tabsResult2 = await send(proc, 'tools/call', {
      name: 'list_tabs',
      arguments: {},
    });
    const text2 = JSON.parse(tabsResult2.content[0].text);
    console.log('   SECOND_CALL_OK —', text2.length, 'tabs');
    console.log('\n=== RUNTIME_TEST_OK ===');
  } finally {
    clearTimeout(timer);
    proc.kill();
    hub.kill();
    await new Promise(r => setTimeout(r, 300));
  }
}

run().catch(err => {
  console.error('FATAL:', err.message);
  process.exitCode = 1;
});
