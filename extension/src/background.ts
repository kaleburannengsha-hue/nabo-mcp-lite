import 'webextension-polyfill';
import BrowserContext from './browser/context';
import { createMcpConnectionManager } from './mcp/connection';
import { installMcpWakeAlarm } from './mcp/wake-alarm';
import { createLogger } from './log';
import { injectBuildDomTreeScripts } from './browser/dom/service';
import { createToolHandler } from './tools';

const logger = createLogger('Background');

// ── Browser context singleton ──
const browserContext = new BrowserContext({});
const handleTool = createToolHandler(browserContext);

// ── Tab lifecycle ──
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    void injectBuildDomTreeScripts(tabId);
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  browserContext.removeAttachedPage(tabId);
});

// ── MCP connection ──
const mcpConnection = createMcpConnectionManager({
  url: 'ws://127.0.0.1:9876',
  onMessage(message, reply) {
    const msg = message as { id: string; type: string; tool?: string; args?: Record<string, unknown> };
    if (msg.type === 'call_tool' && msg.tool) {
      handleTool(msg.tool, msg.args || {})
        .then(result => reply({ id: msg.id, type: 'tool_result', result }))
        .catch(err => {
          const error = err instanceof Error ? err.message : String(err);
          logger.error('Tool error: ' + error);
          reply({ id: msg.id, type: 'tool_error', error });
        });
    }
  },
  logger: {
    info: (msg: string) => logger.info(msg),
    warning: (msg: string) => logger.warning(msg),
  },
});

mcpConnection.ensureConnected();
installMcpWakeAlarm({
  alarms: chrome.alarms,
  ensureConnected: () => mcpConnection.ensureConnected(),
});
