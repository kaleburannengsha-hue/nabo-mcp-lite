#!/usr/bin/env node
'use strict';

// Helper: call nabo tool via WebSocket hub
const { WebSocket } = require('ws');
const path = require('path');
const fs = require('fs');

const HUB_URL = 'ws://127.0.0.1:9877';
const SCREENSHOT_DIR = process.env.NABO_SCREENSHOT_DIR || path.resolve(__dirname, '../screenshots');
const TIMEOUT = 30000;

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function callTool(tool, args = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(HUB_URL);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout: ${tool}`));
    }, TIMEOUT);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: '1', type: 'call_tool', tool, args }));
    });
    ws.on('message', data => {
      clearTimeout(timer);
      const msg = JSON.parse(data.toString());
      ws.close();
      if (msg.type === 'tool_result') {
        resolve(msg.result);
      } else if (msg.type === 'tool_error') {
        reject(new Error(msg.error));
      } else {
        resolve(msg);
      }
    });
    ws.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function getDom(useVision = false) {
  return callTool('get_dom', { use_vision: useVision });
}

async function navigate(url) {
  return callTool('navigate', { url });
}

async function clickElement(index) {
  return callTool('click_element', { index });
}

async function inputText(index, text) {
  return callTool('input_text', { index, text });
}

async function sendKeys(keys) {
  return callTool('send_keys', { keys });
}

async function executeScript(code) {
  return callTool('execute_script', { code });
}

async function getPageText() {
  return callTool('get_page_text');
}

async function screenshot(fullPage = false) {
  return callTool('screenshot', { full_page: fullPage });
}

async function listTabs() {
  return callTool('list_tabs');
}

async function switchTab(tabId) {
  return callTool('switch_tab', { tab_id: tabId });
}

// Save screenshot from getDom result
function saveScreenshot(result, filename) {
  if (result && result.screenshot) {
    fs.writeFileSync(path.join(SCREENSHOT_DIR, filename), result.screenshot, 'base64');
    console.log(`Screenshot saved: ${filename} (${result.screenshot.length} bytes)`);
  }
}

// Main: parse command line
const args = process.argv.slice(2);
const cmd = args[0];

(async () => {
  try {
    switch (cmd) {
      case 'tabs': {
        const tabs = await listTabs();
        console.log(JSON.stringify(tabs, null, 2));
        break;
      }
      case 'switch': {
        const tabId = parseInt(args[1]);
        console.log(await switchTab(tabId));
        break;
      }
      case 'nav': {
        const url = args[1];
        console.log(await navigate(url));
        break;
      }
      case 'dom': {
        const vision = args[1] === 'vision';
        const result = await getDom(vision);
        if (vision && result.screenshot) {
          const fname = args[2] || 'page.jpg';
          saveScreenshot(result, fname);
          const copy = { ...result };
          delete copy.screenshot;
          console.log(JSON.stringify(copy, null, 2));
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
        break;
      }
      case 'screenshot': {
        const result = await screenshot(args[1] === 'full');
        const fname = args[2] || 'screenshot.jpg';
        if (result && result.screenshot) {
          saveScreenshot(result, fname);
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
        break;
      }
      case 'click': {
        const idx = parseInt(args[1]);
        console.log(await clickElement(idx));
        break;
      }
      case 'type': {
        const idx = parseInt(args[1]);
        const text = args.slice(2).join(' ');
        console.log(await inputText(idx, text));
        break;
      }
      case 'keys': {
        const keys = args.slice(1).join(' ');
        console.log(await sendKeys(keys));
        break;
      }
      case 'eval': {
        const code = args.slice(1).join(' ');
        console.log(JSON.stringify(await executeScript(code), null, 2));
        break;
      }
      case 'text': {
        const result = await getPageText();
        if (typeof result === 'object') {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result);
        }
        break;
      }
      default: {
        console.log(`Usage: node nabo-helper.cjs <cmd> [args]`);
        console.log('Commands: tabs, switch <id>, nav <url>, dom [vision] [file], screenshot [full] [file], click <idx>, type <idx> <text>, keys <keys>, eval <code>, text');
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
