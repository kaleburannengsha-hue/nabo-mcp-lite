import type { DOMElementNode } from './dom/views';

/**
 * Per-page DOM state cache.
 *
 * A browser task usually walks the same site repeatedly: page A → page B → back
 * to A. Re-scanning page A on every return costs ~1s and a full DOM walk, so we
 * keep the last scan of each (tab, URL) and reuse it.
 *
 * Reuse is gated by identity verification at click time (see
 * Page.clickElementNode verifyIdentity): an index is only trusted when the
 * element it resolves to still carries the tag/text/id the scan recorded. A
 * stale entry therefore fails loudly instead of clicking the wrong element.
 */
export interface DomCacheEntry {
  url: string;
  title: string;
  selectorMap: Map<number, DOMElementNode>;
  elementTree: DOMElementNode;
  scannedAt: number;
  hits: number;
}

export interface CacheStats {
  scans: number;
  hits: number;
  missUnknownUrl: number;
  expired: number;
  identityOk: number;
  identityFailed: number;
  clicks: number;
  clickErrors: number;
  /** Cache hits whose original node was gone but the same control was found by identity. */
  relocated: number;
  /** Scans that first came back with nothing clickable (heavy pages still settling). */
  emptyScans: number;
  /** Empty scans that a single retry recovered. */
  retryRecovered: number;
}

const MAX_ENTRIES = 16;
const MAX_AGE_MS = 30 * 60 * 1000;

export class DomStateCache {
  private map = new Map<string, DomCacheEntry>();
  readonly stats: CacheStats = {
    scans: 0,
    hits: 0,
    missUnknownUrl: 0,
    expired: 0,
    identityOk: 0,
    identityFailed: 0,
    clicks: 0,
    clickErrors: 0,
    relocated: 0,
    emptyScans: 0,
    retryRecovered: 0,
  };

  private key(tabId: number, url: string): string {
    return `${tabId}|${url}`;
  }

  set(
    tabId: number,
    url: string,
    title: string,
    selectorMap: Map<number, DOMElementNode>,
    elementTree: DOMElementNode,
  ): void {
    this.stats.scans++;
    // Newest first, so eviction drops the least recently used entry.
    const entry: DomCacheEntry = { url, title, selectorMap, elementTree, scannedAt: Date.now(), hits: 0 };
    this.map.delete(this.key(tabId, url));
    this.map.set(this.key(tabId, url), entry);
    while (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get(tabId: number, url: string): DomCacheEntry | null {
    const key = this.key(tabId, url);
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.scannedAt > MAX_AGE_MS) {
      this.map.delete(key);
      this.stats.expired++;
      return null;
    }
    // LRU touch
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  invalidate(tabId: number, url?: string): void {
    if (url !== undefined) {
      this.map.delete(this.key(tabId, url));
      return;
    }
    for (const key of Array.from(this.map.keys())) {
      if (key.startsWith(`${tabId}|`)) this.map.delete(key);
    }
  }

  describe(): Array<{ url: string; title: string; elements: number; ageSec: number; hits: number }> {
    return Array.from(this.map.values()).map(e => ({
      url: e.url,
      title: e.title,
      elements: e.selectorMap.size,
      ageSec: Math.round((Date.now() - e.scannedAt) / 1000),
      hits: e.hits,
    }));
  }
}

export const domCache = new DomStateCache();

/**
 * Normalized identity of a live element, compared against the cached node
 * before a click is allowed through.
 */
export interface ElementIdentity {
  tag: string;
  text: string;
  id: string;
  type: string;
  href: string;
  /** True for elements whose text is data (we may have written it), not a label. */
  isContentElement: boolean;
}

const CONTENT_TAGS = new Set(['input', 'textarea', 'select']);

export function identityFromNode(node: DOMElementNode): ElementIdentity {
  const attrs = node.attributes || {};
  const tag = (node.tagName || '').toLowerCase();
  return {
    tag,
    text: (node.getAllTextTillNextClickableElement() || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    id: attrs.id || '',
    type: (attrs.type || '').toLowerCase(),
    href: attrs.href || '',
    isContentElement: CONTENT_TAGS.has(tag) || (attrs.contenteditable || '').toLowerCase() === 'true',
  };
}

/** Thrown when a cached element no longer matches the live DOM — never click in that case. */
export class IdentityMismatchError extends Error {}

/**
 * True when the live element still looks like the one that was scanned.
 * Conservative by design: tag, id and input type must agree exactly; when the
 * scan recorded text, that text (whitespace-insensitive, first 40 chars) must
 * appear in the live element. Class names are ignored — they change with
 * hover/active state and would cause false rejections.
 */
export function identityMatches(expected: ElementIdentity, actual: ElementIdentity): boolean {
  if (expected.tag && actual.tag !== expected.tag) return false;
  if (expected.id && actual.id !== expected.id) return false;
  if (expected.type && actual.type !== expected.type) return false;

  // A matching non-empty id is decisive: ids are unique per document, so this
  // is the same element even if its text changed under us.
  if (expected.id && actual.id) return true;

  // Inputs, textareas, selects and contenteditable hold data, not a label —
  // and we write that data, so comparing it would reject our own edits
  // (e.g. clicking a search box again after typing into it).
  if (expected.isContentElement || actual.isContentElement) return true;

  const squeeze = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  const key = squeeze(expected.text).slice(0, 40);
  if (key && !squeeze(actual.text).includes(key)) return false;
  return true;
}
