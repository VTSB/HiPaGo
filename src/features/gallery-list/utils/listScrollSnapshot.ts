const HISTORY_LIST_SCROLL_KEY = 'hipagoListScrollSnapshot';
const SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;

export type ListScrollSnapshot = {
  version: 1;
  url: string;
  at: number;
  scrollY: number;
  ts: number;
  anchorIndex: number;
  anchorTop: number;
  clickedIndex: number | null;
  clickedId: number | null;
  viewportWidth: number;
};

type HistoryStateWithListScroll = {
  [HISTORY_LIST_SCROLL_KEY]?: unknown;
};

function currentListUrl(): string {
  return window.location.pathname + window.location.search;
}

function normalizeListUrl(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.origin);
    parsed.searchParams.delete('at');
    parsed.searchParams.delete('page');
    parsed.searchParams.sort();
    return parsed.pathname + parsed.search;
  } catch {
    return null;
  }
}

function sameListUrl(snapshotUrl: string): boolean {
  return normalizeListUrl(snapshotUrl) === normalizeListUrl(currentListUrl());
}

function coerceSnapshot(value: unknown): ListScrollSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<ListScrollSnapshot>;
  if (
    typeof parsed.url !== 'string' ||
    typeof parsed.at !== 'number' ||
    typeof parsed.scrollY !== 'number' ||
    typeof parsed.ts !== 'number'
  ) {
    return null;
  }
  if (Date.now() - parsed.ts > SNAPSHOT_MAX_AGE_MS) return null;
  if (!sameListUrl(parsed.url)) return null;

  const at = Math.max(0, parsed.at);
  return {
    version: 1,
    url: parsed.url,
    at,
    scrollY: Math.max(0, parsed.scrollY),
    ts: parsed.ts,
    anchorIndex: typeof parsed.anchorIndex === 'number' ? Math.max(0, parsed.anchorIndex) : at,
    anchorTop: typeof parsed.anchorTop === 'number' ? parsed.anchorTop : 0,
    clickedIndex: typeof parsed.clickedIndex === 'number' ? Math.max(0, parsed.clickedIndex) : null,
    clickedId: typeof parsed.clickedId === 'number' ? parsed.clickedId : null,
    viewportWidth: typeof parsed.viewportWidth === 'number' ? Math.max(0, parsed.viewportWidth) : 0,
  };
}

function getItemIndex(el: Element | null): number | null {
  if (!(el instanceof HTMLElement)) return null;
  const raw = el.dataset.itemIndex;
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getAnchorElement(): HTMLElement | null {
  const items = Array.from(document.querySelectorAll<HTMLElement>('[data-item-index]'));
  if (items.length === 0) return null;

  let fallback: HTMLElement | null = null;
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    if (rect.bottom < 0) continue;
    if (!fallback && rect.top < window.innerHeight) fallback = item;
    if (rect.top <= 100) fallback = item;
  }
  return fallback;
}

export function captureListScrollSnapshot(clickedElement: Element, clickedId: number): void {
  const anchorElement = getAnchorElement();
  const anchorIndex = getItemIndex(anchorElement) ?? 0;
  const clickedIndex = getItemIndex(clickedElement.closest('[data-item-index]'));
  const snapshot: ListScrollSnapshot = {
    version: 1,
    url: currentListUrl(),
    at: anchorIndex,
    scrollY: window.scrollY,
    ts: Date.now(),
    anchorIndex,
    anchorTop: anchorElement?.getBoundingClientRect().top ?? 0,
    clickedIndex,
    clickedId,
    viewportWidth: window.innerWidth,
  };

  const currentState =
    typeof window.history.state === 'object' && window.history.state !== null
      ? window.history.state
      : {};
  window.history.replaceState(
    {
      ...currentState,
      [HISTORY_LIST_SCROLL_KEY]: snapshot,
    },
    '',
    currentListUrl(),
  );
}

export function readListScrollSnapshot(): ListScrollSnapshot | null {
  const state = window.history.state as HistoryStateWithListScroll | null;
  return coerceSnapshot(state?.[HISTORY_LIST_SCROLL_KEY]);
}
