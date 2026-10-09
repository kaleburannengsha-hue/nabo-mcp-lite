import BrowserContext from './browser/context';
import {
  clearTabLayout,
  ensureTabLayout,
  injectBuildDomTreeScripts,
  lastScanTrace,
  probeBuildDomTree,
  type InjectionReport,
} from './browser/dom/service';
import { DEFAULT_INCLUDE_ATTRIBUTES } from './browser/dom/views';
import { domCache, IdentityMismatchError } from './browser/dom-cache';
import type { DOMElementNode } from './browser/dom/views';

/**
 * Look up an element index in the per-URL DOM cache for the page's tab.
 * Indices are only meaningful against the scan they came from, so the URL is
 * part of the key: returning to a page you scanned before reuses that scan,
 * while an unscanned URL fails with a pointer to get_dom.
 */
async function resolveCachedNode(
  tabId: number,
  index: number,
): Promise<{ node: DOMElementNode; url: string; scannedAgoSec: number }> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || '';
  const entry = domCache.get(tabId, url);
  if (!entry) {
    domCache.stats.missUnknownUrl++;
    throw new Error(`No cached scan for ${url} in this tab — run get_dom first.`);
  }
  const node = entry.selectorMap.get(index);
  if (!node) {
    throw new Error(
      `Index ${index} is not in the cached scan of ${url} (${entry.selectorMap.size} elements) — run get_dom again.`,
    );
  }
  entry.hits++;
  domCache.stats.hits++;
  return { node, url, scannedAgoSec: Math.round((Date.now() - entry.scannedAt) / 1000) };
}

/**
 * Run an operation with a guaranteed page layout. Tabs created while the
 * window is minimized have a 0x0 viewport and scan as empty; a temporary
 * layout override is applied for the duration and always cleared afterwards.
 */
async function withTabLayout<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const applied = await ensureTabLayout(tabId);
  try {
    return await fn();
  } finally {
    if (applied) await clearTabLayout(tabId);
  }
}

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

async function ensureCdpSession(sessions: Map<number, CdpTabSession>, tabId: number): Promise<CdpTabSession> {
  const existing = sessions.get(tabId);
  if (existing) return existing;

  const debuggee = { tabId };
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
  const session = { debuggee, contextId, attachedByUs };
  sessions.set(tabId, session);
  return session;
}

async function evaluateScriptWithCdp(
  sessions: Map<number, CdpTabSession>,
  tabId: number,
  expression: string,
): Promise<unknown> {
  const session = await ensureCdpSession(sessions, tabId);
  const debuggee = session.debuggee;

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

/**
 * Click at viewport coordinates with real CDP mouse events (works on canvas,
 * maps and other non-DOM-indexable targets). Returns what was under the point
 * before clicking, so the caller can verify it hit the intended element.
 */
async function clickAtPoint(
  sessions: Map<number, CdpTabSession>,
  tabId: number,
  x: number,
  y: number,
): Promise<unknown> {
  const session = await ensureCdpSession(sessions, tabId);
  const hit = await evaluateScriptWithCdp(
    sessions,
    tabId,
    `(() => {
      const el = document.elementFromPoint(${x}, ${y});
      if (!el) return null;
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 80),
        id: el.id || '',
        cls: String(el.className || '').slice(0, 60),
      };
    })()`,
  );

  const debuggee = session.debuggee;
  await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    buttons: 0,
  });
  await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });

  return hit;
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
        let injection: InjectionReport | null = null;
        try {
          await page.waitForPageAndFramesLoad();
          injection = await injectBuildDomTreeScripts(page.tabId);
        } catch (e) {
          // continue even if inject fails
        }
        let state = await withTabLayout(page.tabId, () =>
          browserContext.getState((args.use_vision as boolean) || false, false),
        );
        let retried = false;

        // Heavy pages are sometimes still settling when the first scan runs,
        // and the scan then comes back with nothing clickable. Retry once
        // instead of reporting an empty page as fact.
        if (state.selectorMap.size === 0) {
          domCache.stats.emptyScans++;
          const nodeCount = await evaluateScriptWithCdp(
            cdpSessions,
            page.tabId,
            'document.querySelectorAll("*").length',
          ).catch(() => 0);
          if (typeof nodeCount === 'number' && nodeCount > 20) {
            retried = true;
            await new Promise(r => setTimeout(r, 700));
            try {
              // Force: a present-but-dead injected copy passes the presence
              // check yet yields an empty tree, so the retry must re-inject.
              injection = await injectBuildDomTreeScripts(page.tabId, true);
            } catch {
              // keep the previous report
            }
            state = await withTabLayout(page.tabId, () => browserContext.getState(false, false));
            if (state.selectorMap.size > 0) domCache.stats.retryRecovered++;
          }
        }

        // Cheap page-structure signals that decide DOM-index clicking vs
        // visual coordinate clicking (canvas/map/chart targets have no index).
        const pageHints = await evaluateScriptWithCdp(
          cdpSessions,
          page.tabId,
          `(() => {
            const count = (sel) => document.querySelectorAll(sel).length;
            return {
              canvas: count('canvas'),
              svg: count('svg'),
              iframes: count('iframe'),
              domClickable: count('a,button,input,select,textarea,[role=button],[role=link],[role=checkbox],[onclick]'),
              viewport: { w: window.innerWidth, h: window.innerHeight },
            };
          })()`,
        ).catch(() => null);

        const elementsText = state.elementTree.clickableElementsToString(DEFAULT_INCLUDE_ATTRIBUTES);
        // Cache the scan under the tab's URL so later clicks (including after
        // navigating away and back) can reuse it instead of re-scanning.
        const tab = await chrome.tabs.get(page.tabId);
        const cacheUrl = tab.url || state.url;
        domCache.set(page.tabId, cacheUrl, state.title, state.selectorMap, state.elementTree);
        const result: Record<string, unknown> = {
          url: state.url,
          title: state.title,
          elements: elementsText,
          selectorMapSize: state.selectorMap.size,
          cached: true,
          pageHints,
          tabs: state.tabs,
        };
        if (retried) result.retriedEmptyScan = true;
        if (state.selectorMap.size === 0) {
          // Surface why a scan came back empty instead of letting the caller
          // conclude the page has nothing clickable.
          result.scanDiagnostics = {
            injection,
            stateError: page.getLastStateError(),
            probe: await probeBuildDomTree(page.tabId),
            trace: { ...lastScanTrace },
            validWebPage: page.validWebPage,
            pageUrl: page.url(),
            attached: page.attached,
            hint: 'Empty scan: check scanDiagnostics; get_page_text/screenshot can fall back.',
          };
        }
        return result;
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
        const fullPage = (args.full_page as boolean) || false;
        const scale = typeof args.scale === 'number' ? args.scale : 0.5;
        const quality = typeof args.quality === 'number' ? args.quality : 80;
        const info = await page.takeScreenshotInfo(fullPage, scale, quality);
        if (!info) throw new Error('Screenshot failed');
        return { screenshot: info.data, width: info.width, height: info.height, scale };
      }

      // Dev convenience: reload the unpacked extension without a manual click.
      case 'reload_extension': {
        // Defer so the tool result flushes before the service worker dies.
        setTimeout(() => chrome.runtime.reload(), 500);
        return { success: true, message: 'Extension reloading' };
      }

      // ── Element interaction ──
      case 'click_at': {
        const x = args.x as number;
        const y = args.y as number;
        if (typeof x !== 'number' || typeof y !== 'number') throw new Error('x and y are required');
        const page = await browserContext.getCurrentPage();
        if (!page) throw new Error('No active page');
        const hit = await clickAtPoint(cdpSessions, page.tabId, x, y);
        return { success: true, x, y, hit };
      }

      case 'upload_file': {
        const index = args.index as number;
        const paths = args.paths;
        if (typeof index !== 'number') throw new Error('index is required');
        if (!Array.isArray(paths) || paths.length === 0 || paths.some(p => typeof p !== 'string')) {
          throw new Error('paths must be a non-empty array of local absolute file paths');
        }
        const page = await browserContext.getCurrentPage();
        if (!page) throw new Error('No active page');
        const state = await browserContext.getState(false, false);
        const elementNode = state.selectorMap.get(index);
        if (!elementNode) throw new Error(`Element with index ${index} not found`);
        await page.uploadFileToElement(elementNode, paths as string[]);
        return { success: true, count: (paths as string[]).length };
      }

      case 'click_element': {
        const index = args.index as number;
        if (typeof index !== 'number') throw new Error('index is required');
        const page = await browserContext.getCurrentPage();
        if (!page) throw new Error('No active page');
        const { node: elementNode, url, scannedAgoSec } = await resolveCachedNode(page.tabId, index);
        // Clicking a file input opens the OS file dialog and stalls the tab.
        if (elementNode.tagName === 'input' && (elementNode.attributes?.type || '').toLowerCase() === 'file') {
          throw new Error(
            `Element ${index} is a file input — clicking it opens the OS file dialog and blocks the tab. Use upload_file(index, paths) instead.`,
          );
        }
        domCache.stats.clicks++;
        try {
          const { recovered } = await withTabLayout(page.tabId, () =>
            page.clickElementNode(!!args.use_vision, elementNode, true),
          );
          domCache.stats.identityOk++;
          if (recovered) domCache.stats.relocated++;
          return {
            success: true,
            source: recovered ? 'identity-relocated' : 'cache',
            url,
            scannedAgoSec,
            verified: true,
          };
        } catch (err) {
          domCache.stats.clickErrors++;
          if (err instanceof IdentityMismatchError) domCache.stats.identityFailed++;
          throw err;
        }
      }

      case 'input_text': {
        const index = args.index as number;
        const text = args.text as string;
        if (typeof index !== 'number') throw new Error('index is required');
        if (!text) throw new Error('text is required');
        const page = await browserContext.getCurrentPage();
        if (!page) throw new Error('No active page');
        const { node: elementNode, url, scannedAgoSec } = await resolveCachedNode(page.tabId, index);
        domCache.stats.clicks++;
        try {
          const { recovered } = await withTabLayout(page.tabId, () =>
            page.inputTextElementNode(!!args.use_vision, elementNode, text, true),
          );
          domCache.stats.identityOk++;
          if (recovered) domCache.stats.relocated++;
          return {
            success: true,
            source: recovered ? 'identity-relocated' : 'cache',
            url,
            scannedAgoSec,
            verified: true,
          };
        } catch (err) {
          domCache.stats.clickErrors++;
          if (err instanceof IdentityMismatchError) domCache.stats.identityFailed++;
          throw err;
        }
      }

      case 'browser_stats': {
        return { stats: domCache.stats, cache: domCache.describe() };
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

      // ── XHS 小红书 ──
      case 'xhs_check_login': {
        const page = await browserContext.getCurrentPage();
        if (!page) throw new Error('No active page');

        // Navigate to XHS home
        await browserContext.navigateTo('https://www.xiaohongshu.com');
        // Clear stale CDP session after navigation (context gets destroyed)
        cdpSessions.delete(page.tabId);
        // Wait for page to load
        await new Promise(r => setTimeout(r, 4000));

        // Check login via cookie (CDP isolated world can't see window.__INITIAL_STATE__)
        const result = await evaluateScriptWithCdp(cdpSessions, page.tabId, `
          (() => {
            try {
              const cookie = document.cookie;
              if (cookie.includes('a1=')) {
                // Try to get user info from page DOM
                const avatar = document.querySelector('[class*="avatar"]') || document.querySelector('img[class*="avatar"]');
                const nick = document.querySelector('[class*="nickname"]') || document.querySelector('[class*="user-name"]');
                return {
                  logged_in: true,
                  nickname: nick ? nick.textContent?.trim() || '已登录' : '已登录（从 cookie 检测）',
                  cookie_has_a1: true
                };
              }
              return { logged_in: false, message: '未登录' };
            } catch(e) {
              return { logged_in: false, message: '检测失败: ' + e.message };
            }
          })()
        `);
        return result;
      }

      case 'xhs_search': {
        const keyword = args.keyword as string;
        if (!keyword) throw new Error('keyword is required');
        const limit = (args.limit as number) || 20;
        const actualLimit = Math.min(Math.max(limit, 1), 30);

        const page = await browserContext.getCurrentPage();
        if (!page) throw new Error('No active page');

        // Navigate to XHS search page
        const searchUrl = 'https://www.xiaohongshu.com/search_result?keyword=' +
          encodeURIComponent(keyword) + '&source=web_search_result_notes';
        await browserContext.navigateTo(searchUrl);
        // Clear stale CDP session after navigation
        cdpSessions.delete(page.tabId);
        // Wait for SSR data to load
        await new Promise(r => setTimeout(r, 5000));

        // Build the CDP eval script as plain string to avoid template-literal regex escaping issues
        const searchScript = [
          '(() => {',
          '  try {',
          '    const items = document.querySelectorAll("section.note-item");',
          '    if (!items || items.length === 0) {',
          '      const captcha = document.querySelector(\'[class*="captcha"], #captcha, [class*="verify"]\');',
          '      if (captcha) return { error: "页面被风控拦截，请手动完成验证后重试" };',
          '      const bodyText = document.body ? document.body.innerText.slice(0, 300) : "";',
          '      return { error: "未找到搜索结果", hint: "页面可能未加载完成", bodyPreview: bodyText };',
          '    }',
          '    const limit = ' + actualLimit + ';',
          '    var feeds = [];',
          '    for (var i = 0; i < Math.min(items.length, limit); i++) {',
          '      var el = items[i];',
          '      var noteId = el.getAttribute("data-note-id") || "";',
          '      var titleEl = el.querySelector(".footer a.title span, .footer .title span, .footer .title");',
          '      var title = titleEl ? titleEl.textContent.trim() : "";',
          '      var authorEl = el.querySelector(".card-bottom-wrapper .author .name, .author .name");',
          '      var user = authorEl ? authorEl.textContent.trim() : "";',
          '      var authorLink = el.querySelector(".card-bottom-wrapper a.author, a.author");',
          '      var authorHref = authorLink ? authorLink.getAttribute("href") || "" : "";',
          '      var userIdMatch = authorHref.match(/\\/user\\/profile\\/([^?]+)/);',
          '      var userId = userIdMatch ? userIdMatch[1] : "";',
          '      var likeEl = el.querySelector(".like-wrapper .count, .like-active .count, [class*=\\"like\\"] .count");',
          '      var likesRaw = likeEl ? likeEl.textContent.trim() : "0";',
          '      var likes = /^\\d+$/.test(likesRaw) ? likesRaw : "0";',
          '      var timeEl = el.querySelector(".card-bottom-wrapper .time, .author .time");',
          '      var time = timeEl ? timeEl.textContent.trim() : "";',
          '      var imgEl = el.querySelector(".cover img, img");',
          '      var cover = imgEl ? (imgEl.src || imgEl.getAttribute("data-src") || "") : "";',
          '      var titleLink = el.querySelector(".footer a.title, .footer .title");',
          '      var titleHref = titleLink ? titleLink.getAttribute("href") || "" : "";',
          '      var xsecMatch = titleHref.match(/xsec_token=([^&]+)/);',
          '      var xsec = xsecMatch ? decodeURIComponent(xsecMatch[1]) : "";',
          '      var url = noteId ? ("https://www.xiaohongshu.com/explore/" + noteId + (xsec ? "?xsec_token=" + xsec + "&xsec_source=pc_search" : "")) : "";',
          '      feeds.push({',
          '        id: noteId,',
          '        title: title,',
          '        user: user,',
          '        user_id: userId,',
          '        likes: likes,',
          '        time: time,',
          '        xsec_token: xsec,',
          '        url: url,',
          '        cover: cover',
          '      });',
          '    }',
          '    return { feeds: feeds, count: feeds.length, total: items.length, keyword: "' + keyword.replace(/'/g, "\\'") + '" };',
          '  } catch(e) {',
          '    return { error: "解析搜索数据失败: " + e.message };',
          '  }',
          '})()',
        ].join('\n');
        const result = await evaluateScriptWithCdp(cdpSessions, page.tabId, searchScript);
        return result;
      }

      case 'xhs_detail': {
        const noteId = args.note_id as string;
        if (!noteId) throw new Error('note_id is required');
        const xsecToken = (args.xsec_token as string) || '';

        const page = await browserContext.getCurrentPage();
        if (!page) throw new Error('No active page');

        // Build detail page URL — xsec_token is CRITICAL to avoid 404
        let detailUrl = 'https://www.xiaohongshu.com/explore/' + noteId;
        if (xsecToken) {
          detailUrl += '?xsec_token=' + xsecToken + '&xsec_source=pc_feed';
        }
        await browserContext.navigateTo(detailUrl);
        // Clear stale CDP session after navigation
        cdpSessions.delete(page.tabId);
        // Wait for page to load
        await new Promise(r => setTimeout(r, 4000));

        // Extract note detail from inline script tag (SSR data) with DOM fallback
        const detailScript = [
          '(() => {',
          '  try {',
          '    // First try: SSR data from inline script tag',
          '    var scripts = document.querySelectorAll("script:not([src])");',
          '    var state = null;',
          '    for (var si = 0; si < scripts.length; si++) {',
          '      var t = scripts[si].textContent || "";',
          '      var idx = t.indexOf("window.__INITIAL_STATE__=");',
          '      if (idx === -1) continue;',
          '      var after = t.slice(idx);',
          '      var equalsPos = after.indexOf("=");',
          '      var jsonStr = after.slice(equalsPos + 1).trim();',
          '      jsonStr = jsonStr.replace(/:undefined([,\\s\\}])/g, ":null$1");',
          '      try {',
          '        state = JSON.parse(jsonStr);',
          '        break;',
          '      } catch(parseErr) {}',
          '    }',
          '',
          '    if (state && state.note) {',
          '      var noteData = state.note;',
          '      var noteDetailMap = noteData.noteDetailMap;',
          '      var note = null;',
          '      if (noteDetailMap) {',
          '        var keys = Object.keys(noteDetailMap);',
          '        if (keys.length > 0) {',
          '          var detail = noteDetailMap[keys[0]];',
          '          note = detail && detail.note;',
          '        }',
          '      }',
          '      if (!note) note = noteData.firstPageNoteInfo || noteData.noteDetail || {};',
          '      if (note && (note.title || note.desc)) {',
          '        var interact = note.interactInfo || {};',
          '        var user = note.user || {};',
          '        var images = (note.imageList || []).map(function(img) {',
          '          return img.urlDefault || img.url || (img.infoList && img.infoList[0] ? img.infoList[0].url : "") || "";',
          '        }).filter(function(x) { return !!x; });',
          '        return {',
          '          note_id: note.noteId || "",',
          '          title: note.title || "",',
          '          desc: note.desc || "",',
          '          user: user.nickname || "",',
          '          user_id: user.userId || "",',
          '          avatar: user.avatar || "",',
          '          likes: interact.likedCount || "0",',
          '          comments: interact.commentCount || "0",',
          '          collects: interact.collectedCount || "0",',
          '          shares: interact.shareCount || "0",',
          '          type: note.type || "",',
          '          ip_location: note.ipLocation || "",',
          '          time: note.time || 0,',
          '          tag_list: (note.tagList || []).map(function(t) { return t.name || ""; }),',
          '          url: "https://www.xiaohongshu.com/explore/" + (note.noteId || "' + noteId + '"),',
          '          images: images,',
          '          source: "ssr"',
          '        };',
          '      }',
          '    }',
          '',
          '    // Fallback: extract from DOM',
          '    var titleEl = document.querySelector("#detail-title") ||',
          '                  document.querySelector("[class*=\\"note-title\\"]") ||',
          '                  document.querySelector("h1") ||',
          '                  document.querySelector(".title");',
          '    var title = titleEl ? titleEl.textContent.trim() : "";',
          '    var descEl = document.querySelector("#detail-desc") ||',
          '                 document.querySelector("[class*=\\"note-text\\"]") ||',
          '                 document.querySelector("[class*=\\"note-scroller\\"]");',
          '    var desc = descEl ? descEl.textContent.trim() : "";',
          '    if (!title && !desc) {',
          '      return { error: "笔记详情页未加载完整，可能需提供 xsec_token", note_id: "' + noteId + '" };',
          '    }',
          '    var avatarEl = document.querySelector("[class*=\\"avatar\\"] img") || document.querySelector("img[class*=\\"avatar\\"]");',
          '    var nickEl = document.querySelector("[class*=\\"nickname\\"]") || document.querySelector("[class*=\\"username\\"]") || document.querySelector(".author .name");',
          '    var interactItems = document.querySelectorAll(".interact-item");',
          '    var likes = "0", comments = "0", collects = "0";',
          '    interactItems.forEach(function(item) {',
          '      var text = item.textContent || "";',
          '      var count = item.querySelector(".count");',
          '      var countText = count ? count.textContent.trim() : "";',
          '      if (text.indexOf("赞") !== -1 || text.indexOf("like") !== -1) likes = countText || "0";',
          '      if (text.indexOf("评") !== -1 || text.indexOf("comment") !== -1) comments = countText || "0";',
          '      if (text.indexOf("收") !== -1 || text.indexOf("collect") !== -1) collects = countText || "0";',
          '    });',
          '    return {',
          '      note_id: "' + noteId + '",',
          '      title: title,',
          '      desc: desc,',
          '      user: nickEl ? nickEl.textContent.trim() : "",',
          '      avatar: avatarEl ? (avatarEl.src || "") : "",',
          '      likes: likes,',
          '      comments: comments,',
          '      collects: collects,',
          '      source: "dom_fallback"',
          '    };',
          '  } catch(e) {',
          '    return { error: "解析笔记详情失败: " + e.message };',
          '  }',
          '})()',
        ].join('\n');
        const result = await evaluateScriptWithCdp(cdpSessions, page.tabId, detailScript);
        return result;
      }

      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  };
}
