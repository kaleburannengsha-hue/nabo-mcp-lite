'use strict';

const TOOLS = [
  {
    name: 'list_tabs',
    description: 'List all open browser tabs with ID, title, URL, and active state',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_dom',
    description:
      'Scan the page and return indexed interactive elements. Call this ONCE per page state, then click/type by index (indices are cached per tab+URL, so returning to a page reuses the scan). Check pageHints: canvas/svg > 0 means some targets have no DOM index and need click_at instead.',
    inputSchema: {
      type: 'object',
      properties: { use_vision: { type: 'boolean', description: 'Include screenshot (default: false)' } },
      required: [],
    },
  },
  {
    name: 'browser_stats',
    description:
      'Cache and click statistics: scans, cache hits, identity-mismatch refusals, click errors, plus the cached pages (URL, element count, age, hits).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_page_text',
    description: 'Get up to 50,000 characters of HTML from the current page, with truncation metadata',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'screenshot',
    description:
      'Take a screenshot of the current page. Default scale 0.5 keeps the JPEG small enough for the model to consume cheaply; use save:true to write it to a local file and get back a path instead of base64 (recommended, ~100x fewer tokens).',
    inputSchema: {
      type: 'object',
      properties: {
        full_page: { type: 'boolean', description: 'Capture full page (default: false)' },
        scale: { type: 'number', description: 'Downscale factor 0.1-1 (default 0.5; 1 = original size)' },
        quality: { type: 'integer', description: 'JPEG quality 20-100 (default 80)' },
        save: { type: 'boolean', description: 'Save to local file and return its path instead of base64 (default: false)' },
      },
      required: [],
    },
  },
  {
    name: 'reload_extension',
    description: 'Reload the Nabo MCP Lite extension in Chrome (dev convenience after rebuilding dist/)',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'click_at',
    description:
      'Visual fallback click, for targets WITH NO DOM INDEX: canvas, map, chart, video controls, image maps, or when get_dom returns 0 elements but a screenshot shows the control. Read coordinates off a screenshot — if it was taken with scale s, multiply by 1/s first. Returns the element under the point so you can verify before/after. Prefer click_element whenever the target has an index.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X in viewport CSS pixels (screenshot_x / scale)' },
        y: { type: 'number', description: 'Y in viewport CSS pixels (screenshot_y / scale)' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'upload_file',
    description:
      'Attach local file(s) to a file input element on the page via CDP (sets input.files and fires change). Paths are absolute paths on this machine. Index comes from get_dom.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: 'File input element index from get_dom' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute local file paths to attach',
        },
      },
      required: ['index', 'paths'],
    },
  },
  {
    name: 'click_element',
    description:
      'DEFAULT way to click: use for any button/link/checkbox/tab that appears in get_dom indices. Verified against the scanned identity, so a stale index is refused rather than mis-clicked. Use click_at ONLY for targets with no DOM index (canvas, maps, charts, video controls, image maps), or when the scan is empty but a screenshot shows the control.',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'integer', description: 'Element highlight index from get_dom output' } },
      required: ['index'],
    },
  },
  {
    name: 'input_text',
    description:
      'Type into an input/textarea/contenteditable from get_dom indices (ASCII and CJK both work). Clears the field first and fires input/change events. To submit afterwards use send_keys("Enter") or click_element on the submit button. Prefer this over keyboard-only flows: it targets the field by verified identity instead of relying on focus.',
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
    description:
      'FASTEST, most reliable path when the destination URL is known or predictable (e.g. /search?q=..., /list?page=2, item URLs you have seen): no scan, no element lookup, no mis-click risk, one call. Rule of thumb: do a flow once by clicking, note the resulting URL pattern, then navigate directly on repeat. Use clicking when the URL pattern is unknown or when the site needs a real click (session/referrer state).',
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
  {
    name: 'xhs_check_login',
    description: '检查小红书登录状态。导航到小红书首页，检查是否已登录。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'xhs_search',
    description: '搜索小红书笔记。导航到搜索结果页，从页面 SSR 数据中提取笔记列表。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词，例如 苏超门票 转让' },
        limit: { type: 'integer', description: '返回数量，默认 20，最大 30', default: 20 },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'xhs_detail',
    description: '获取小红书笔记详情。导航到笔记详情页，提取标题、正文、作者、互动数据。',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: '笔记 ID（完整 24 位，如 6a5eca9b0000000009035551）' },
        xsec_token: { type: 'string', description: '搜索返回的 xsec_token（可选但推荐）' },
      },
      required: ['note_id'],
    },
  },
];

const DEFAULT_EXTENSION_PORT = 9876;
const DEFAULT_HUB_PORT = 9877;
const TOOL_TIMEOUT_MS = 60_000;

function getExtensionPort(env = process.env) {
  return Number(env.MCP_WS_PORT || DEFAULT_EXTENSION_PORT);
}

function getHubPort(env = process.env) {
  return Number(env.MCP_HUB_PORT || DEFAULT_HUB_PORT);
}

module.exports = {
  DEFAULT_EXTENSION_PORT,
  DEFAULT_HUB_PORT,
  TOOL_TIMEOUT_MS,
  TOOLS,
  getExtensionPort,
  getHubPort,
};

