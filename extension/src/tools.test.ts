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
};

(globalThis as unknown as Record<string, unknown>).chrome = mockChrome;

describe('createToolHandler', () => {
  let handler: ReturnType<typeof createToolHandler>;
  let ctx: BrowserContext;

  beforeEach(() => {
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

  it('throws on unknown tool', async () => {
    await expect(handler('unknown_tool', {})).rejects.toThrow('Unknown tool');
  });
});
