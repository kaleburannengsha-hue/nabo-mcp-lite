#!/usr/bin/env node
// scripts/runtime-test.cjs — Lite single-session baseline verification
// Usage: node scripts/runtime-test.cjs
//
// This test starts the single-session MCP server and drives an MCP JSON-RPC
// conversation over stdio.  The Chrome extension must be loaded from dist/
// for browser-dependent tools (list_tabs, get_dom) to succeed.
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const SERVER_PATH = path.resolve(__dirname, '..', 'server', 'single-session-server.cjs');
const IDLE_WAIT_MS = parseInt(process.env.IDLE_WAIT_MS || '45000', 10);
const WS_PORT = parseInt(process.env.MCP_WS_PORT || '9876', 10);
const TIMEOUT_MS = 120000;

let reqId = 0;

function send(proc, method, params) {
  const id = String(++reqId);
  const msg = { jsonrpc: '2.0', id, method };
  if (params) msg.params = params;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 30000);
    proc.onData = null;
    proc.pending = proc.pending || new Map();
    proc.pending.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify(msg) + '\n');
  });
}

function collectOutput(proc, line) {
  try {
    const msg = JSON.parse(line);
    if (msg.id && proc.pending && proc.pending.has(msg.id)) {
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

  // ── 1. Start server ──
  const proc = spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MCP_WS_PORT: String(WS_PORT) },
  });
  proc.pending = new Map();

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
    if (msg) console.error('[server]', msg);
  });

  // Allow server to start
  await new Promise(r => setTimeout(r, 500));

  const timer = setTimeout(() => { proc.kill(); }, TIMEOUT_MS);

  try {
    // ── 2. Initialize ──
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

    // Send initialized notification
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    // ── 3. tools/list ──
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

    // ── 4. list_tabs (requires extension) ──
    console.log(`3. Sending list_tabs through extension on port ${WS_PORT}...`);
    const tabsResult = await waitForExtension(proc);
    const text = JSON.parse(tabsResult.content[0].text);
    console.log('   FIRST_CALL_OK —', text.length, 'tabs');

    const testTab = text.find(tab => /^https?:\/\//.test(tab.url || ''));
    if (!testTab) {
      throw new Error('No regular http(s) tab is available for browser tool verification');
    }
    await send(proc, 'tools/call', {
      name: 'switch_tab',
      arguments: { tab_id: testTab.id },
    });

    // ── 5. get_dom and bounded get_page_text (require extension) ──
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

    // ── 6. Wait 45s idle ──
    console.log(`7. Waiting ${IDLE_WAIT_MS / 1000}s for idle period...`);
    await new Promise(r => setTimeout(r, IDLE_WAIT_MS));

    // ── 7. list_tabs after idle ──
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
    await new Promise(r => setTimeout(r, 200));
  }
}

run().catch(err => {
  console.error('FATAL:', err.message);
  process.exitCode = 1;
});
