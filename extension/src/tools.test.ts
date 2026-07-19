/// <reference types="chrome" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createToolHandler } from './tools';
import type BrowserContext from './browser/context';

// Mock browser context for unit tests
function createMockBrowserContext() {
  const mockPage = {
    tabId: 1,
    waitForPageAndFramesLoad: vi.fn().mockResolvedValue(undefined),
    getContent: vi.fn().mockResolvedValue('<html></html>'),
    takeScreenshot: vi.fn().mockResolvedValue('base64fake'),
    clickElementNode: vi.fn().mockResolvedValue(undefined),
    inputTextElementNode: vi.fn().mockResolvedValue(undefined),
    selectDropdownOption: vi.fn().mockResolvedValue('Selected'),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    scrollToPercent: vi.fn().mockResolvedValue(undefined),
  };

  const mockCtx = {
    switchTab: vi.fn().mockResolvedValue(undefined),
    openTab: vi.fn().mockResolvedValue(undefined),
    closeTab: vi.fn().mockResolvedValue(undefined),
    navigateTo: vi.fn().mockResolvedValue(undefined),
    getCurrentPage: vi.fn().mockResolvedValue(mockPage),
    getState: vi.fn().mockResolvedValue({
      url: 'https://example.com',
      title: 'Test Page',
      elementTree: { clickableElementsToString: () => '[1]<button>Click</button>' },
      selectorMap: new Map([[1, {}]]),
      tabs: [{ id: 1, title: 'Test', url: 'https://example.com' }],
    }),
  } as unknown as BrowserContext;

  return mockCtx;
}

// Mock chrome APIs
const mockChrome = {
  tabs: {
    query: vi.fn().mockResolvedValue([
      { id: 1, title: 'Test', url: 'https://example.com', active: true },
    ]),
  },
  scripting: {
    executeScript: vi.fn().mockResolvedValue([{ result: 'ok' }]),
  },
  debugger: {
    attach: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn().mockImplementation((_, method) => {
      if (method === 'Page.getFrameTree') {
        return Promise.resolve({ frameTree: { frame: { id: 'main-frame' } } });
      }
      if (method === 'Page.createIsolatedWorld') {
        return Promise.resolve({ executionContextId: 7 });
      }
      if (method === 'Runtime.evaluate') {
        return Promise.resolve({ result: { value: 80 } });
      }
      return Promise.resolve({});
    }),
    detach: vi.fn().mockResolvedValue(undefined),
    onEvent: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
};

(globalThis as unknown as Record<string, unknown>).chrome = mockChrome;

describe('createToolHandler', () => {
  let handler: ReturnType<typeof createToolHandler>;
  let ctx: BrowserContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockBrowserContext();
    handler = createToolHandler(ctx);
  });

  it('list_tabs returns tabs', async () => {
    const result = await handler('list_tabs', {});
    expect(result).toEqual([{ id: 1, title: 'Test', url: 'https://example.com', active: true }]);
  });

  it('get_page_text truncates oversized HTML responses', async () => {
    const oversizedHtml = 'x'.repeat(50_001);
    const page = await ctx.getCurrentPage();
    vi.mocked(page!.getContent).mockResolvedValue(oversizedHtml);

    const result = await handler('get_page_text', {});

    expect(result).toEqual({
      content: 'x'.repeat(50_000),
      truncated: true,
      originalLength: 50_001,
    });
  });

  it('navigate throws when url is missing', async () => {
    await expect(handler('navigate', {} as Record<string, unknown>)).rejects.toThrow('url is required');
  });

  it('click_element throws when index is missing', async () => {
    await expect(handler('click_element', {} as Record<string, unknown>)).rejects.toThrow('index is required');
  });

  it('switch_tab throws when tab_id is missing', async () => {
    await expect(handler('switch_tab', {} as Record<string, unknown>)).rejects.toThrow('tab_id is required');
  });

  it('execute_script evaluates in CDP Runtime instead of extension script injection', async () => {
    const result = await handler('execute_script', {
      code: "document.querySelectorAll('.question_box').length",
    });

    expect(mockChrome.debugger.attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3');
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Page.enable');
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Runtime.enable');
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Page.getFrameTree');
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Page.createIsolatedWorld',
      {
        frameId: 'main-frame',
        worldName: 'nabo_mcp_lite',
        grantUniveralAccess: true,
      },
    );
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Runtime.evaluate',
      {
        expression: "document.querySelectorAll('.question_box').length",
        awaitPromise: true,
        contextId: 7,
        returnByValue: true,
        userGesture: true,
      },
    );
    expect(mockChrome.debugger.detach).not.toHaveBeenCalled();
    expect(mockChrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(result).toEqual({ result: 80, mode: 'cdp' });
  });

  it('execute_script reuses an existing debugger attachment when Chrome reports one is already attached', async () => {
    vi.mocked(mockChrome.debugger.attach).mockRejectedValueOnce(
      new Error('Another debugger is already attached to the tab with id: 1.'),
    );

    const result = await handler('execute_script', {
      code: "document.querySelectorAll('.question_box').length",
    });

    expect(mockChrome.debugger.attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3');
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Runtime.evaluate',
      expect.objectContaining({ contextId: 7 }),
    );
    expect(mockChrome.debugger.detach).not.toHaveBeenCalled();
    expect(result).toEqual({ result: 80, mode: 'cdp' });
  });

  it('execute_script reuses the same CDP execution context for repeated calls on a tab', async () => {
    await handler('execute_script', { code: '1 + 1' });
    await handler('execute_script', { code: "document.querySelectorAll('.question_box').length" });

    expect(mockChrome.debugger.attach).toHaveBeenCalledTimes(1);
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Runtime.evaluate',
      expect.objectContaining({ expression: '1 + 1', contextId: 7 }),
    );
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Runtime.evaluate',
      expect.objectContaining({
        expression: "document.querySelectorAll('.question_box').length",
        contextId: 7,
      }),
    );
    expect(mockChrome.debugger.detach).not.toHaveBeenCalled();
  });

  it('throws on unknown tool', async () => {
    await expect(handler('unknown_tool', {})).rejects.toThrow('Unknown tool');
  });
});
