import BrowserContext from './browser/context';
import { injectBuildDomTreeScripts } from './browser/dom/service';
import { DEFAULT_INCLUDE_ATTRIBUTES } from './browser/dom/views';

const MAX_PAGE_TEXT_CHARS = 50_000;

type CdpRuntimeEvaluateResponse = {
  result?: {
    type?: string;
    value?: unknown;
    unserializableValue?: string;
    description?: string;
  };
  exceptionDetails?: {
    text?: string;
    exception?: {
      description?: string;
      value?: unknown;
    };
  };
};

type CdpFrameTreeResponse = {
  frameTree?: {
    frame?: {
      id?: string;
    };
  };
};

type CdpCreateIsolatedWorldResponse = {
  executionContextId?: number;
};

async function createMainFrameExecutionContext(debuggee: chrome.debugger.Debuggee): Promise<number | undefined> {
  await chrome.debugger.sendCommand(debuggee, 'Page.enable');
  await chrome.debugger.sendCommand(debuggee, 'Runtime.enable');
  const frameTree = (await chrome.debugger.sendCommand(debuggee, 'Page.getFrameTree')) as CdpFrameTreeResponse;
  const mainFrameId = frameTree.frameTree?.frame?.id;
  if (!mainFrameId) return undefined;

  const isolatedWorld = (await chrome.debugger.sendCommand(debuggee, 'Page.createIsolatedWorld', {
    frameId: mainFrameId,
    worldName: 'nabo_mcp_lite',
    grantUniveralAccess: true,
  })) as CdpCreateIsolatedWorldResponse;

  if (typeof isolatedWorld.executionContextId !== 'number') {
    return undefined;
  }
  return isolatedWorld.executionContextId;
}

interface CdpTabSession {
  debuggee: chrome.debugger.Debuggee;
  contextId: number;
  attachedByUs: boolean;
}

async function evaluateScriptWithCdp(
  sessions: Map<number, CdpTabSession>,
  tabId: number,
  expression: string,
): Promise<unknown> {
  const debuggee = { tabId };
  let session = sessions.get(tabId);

  if (!session) {
    let attachedByUs = false;
    try {
      await chrome.debugger.attach(debuggee, '1.3');
      attachedByUs = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('Another debugger is already attached')) {
        throw err;
      }
    }
    const contextId = await createMainFrameExecutionContext(debuggee);
    if (typeof contextId !== 'number') {
      throw new Error('Failed to create a page execution context for CDP evaluation');
    }
    session = { debuggee, contextId, attachedByUs };
    sessions.set(tabId, session);
  }

  try {
    const response = (await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      contextId: session.contextId,
    })) as CdpRuntimeEvaluateResponse;

    if (response.exceptionDetails) {
      const exception = response.exceptionDetails.exception;
      const message =
        exception?.description ||
        String(exception?.value ?? '') ||
        response.exceptionDetails.text ||
        'CDP Runtime.evaluate failed';
      throw new Error(message);
    }

    if (response.result && 'value' in response.result) return response.result.value;
    if (response.result?.unserializableValue) return response.result.unserializableValue;
    return response.result?.description ?? null;
  } catch (err) {
    sessions.delete(tabId);
    throw err;
  }
}

export function createToolHandler(browserContext: BrowserContext) {
  const cdpSessions = new Map<number, CdpTabSession>();

  return async function handleTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    switch (tool) {
      // ── Tab management ──
      case 'list_tabs': {
        const tabs = await chrome.tabs.query({});
        return tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
      }

      case 'switch_tab': {
        const tabId = args.tab_id as number;
        if (typeof tabId !== 'number') throw new Error('tab_id is required');
        await browserContext.switchTab(tabId);
        return { success: true };
      }

      case 'open_tab': {
        const url = args.url as string;
        if (!url) throw new Error('url is required');
        await browserContext.openTab(url);
        return { success: true };
      }

      case 'close_tab': {
        const tabId = args.tab_id as number;
        if (typeof tabId !== 'number') throw new Error('tab_id is required');
        await browserContext.closeTab(tabId);
        return { success: true };
      }

      // ── Navigation ──
      case 'navigate': {
        const url = args.url as string;
        if (!url) throw new Error('url is required');
        await browserContext.navigateTo(url);
        return { success: true };
      }

      // ── DOM / Reading ──
      case 'get_dom': {
        const page = await browserContext.getCurrentPage();
        if (!page) throw new Error('No active page');
        try {
          await page.waitForPageAndFramesLoad();
          await injectBuildDomTreeScripts(page.tabId);
        } catch (e) {
          // continue even if inject fails
        }
        const state = await browserContext.getState((args.use_vision as boolean) || false, false);
        const elementsText = state.elementTree.clickableElementsToString(DEFAULT_INCLUDE_ATTRIBUTES);
        return {
          url: state.url,
          title: state.title,
          elements: elementsText,
          selectorMapSize: state.selectorMap.size,
          tabs: state.tabs,
        };
      }

      case 'get_page_text': {
        const page = await browserContext.getCurrentPage();
        if (!page) throw new Error('No active page');
        const content = await page.getContent();
        return {
          content: content.slice(0, MAX_PAGE_TEXT_CHARS),
          truncated: content.length > MAX_PAGE_TEXT_CHARS,
          originalLength: content.length,
        };
      }

      case 'screenshot': {
        const page = await browserContext.getCurrentPage();
        if (!page) throw new Error('No active page');
        const screenshot = await page.takeScreenshot((args.full_page as boolean) || false);
        return { screenshot };
      }

      // ── Element interaction ──
      case 'click_element': {
        const index = args.index as number;
        if (typeof index !== 'number') throw new Error('index is required');
        const page = await browserContext.getCurrentPage();
        if (!page) throw new Error('No active page');
        const state = await browserContext.getState(false, false);
        const elementNode = state.selectorMap.get(index);
        if (!elementNode) throw new Error(`Element with index ${index} not found`);
        await page.clickElementNode(!!args.use_vision, elementNode);
        return { success: true };
      }

      case 'input_text': {
        const index = args.index as number;
        const text = args.text as string;
        if (typeof index !== 'number') throw new Error('index is required');
        if (!text) throw new Error('text is required');
        const page = await browserContext.getCurrentPage();
        if (!page) throw new Error('No active page');
        const state = await browserContext.getState(false, false);
        const elementNode = state.selectorMap.get(index);
        if (!elementNode) throw new Error(`Element with index ${index} not found`);
        await page.inputTextElementNode(!!args.use_vision, elementNode, text);
        return { success: true };
      }

      case 'select_option': {
        const index = args.index as number;
        const text = args.text as string;
        if (typeof index !== 'number') throw new Error('index is required');
        if (!text) throw new Error('text is required');
        const page = await browserContext.getCurrentPage();
        if (!page) throw new Error('No active page');
        const result = await page.selectDropdownOption(index, text);
        return { result };
      }

      case 'send_keys': {
        const keys = args.keys as string;
        if (!keys) throw new Error('keys is required');
        const page = await browserContext.getCurrentPage();
        if (!page) throw new Error('No active page');
        await page.sendKeys(keys);
        return { success: true };
      }

      case 'scroll': {
        const yPercent = args.y_percent as number;
        if (typeof yPercent !== 'number') throw new Error('y_percent is required');
        const page = await browserContext.getCurrentPage();
        if (!page) throw new Error('No active page');
        await page.scrollToPercent(yPercent);
        return { success: true };
      }

      // ── Generic JS ──
      case 'execute_script': {
        const code = args.code as string;
        if (!code) throw new Error('code is required');
        const page = await browserContext.getCurrentPage();
        if (!page) throw new Error('No active page');
        const result = await evaluateScriptWithCdp(cdpSessions, page.tabId, code);
        return { result, mode: 'cdp' };
      }

      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  };
}
