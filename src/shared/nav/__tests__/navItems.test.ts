import { describe, it, expect } from 'vitest';
import { BOTTOM_TABS, NAV_ITEMS, isNavActive, isStackedRoute, isRootTab } from '../navItems';

describe('navItems — bottom tab set', () => {
  it('exposes exactly 4 mobile tabs in order', () => {
    expect(BOTTOM_TABS.map((t) => t.href)).toEqual(['/', '/search', '/library', '/settings']);
  });

  it('Browse tab matches only the exact root', () => {
    const browse = BOTTOM_TABS[0];
    expect(browse.matches('/')).toBe(true);
    expect(browse.matches('/search')).toBe(false);
    expect(browse.matches('/library')).toBe(false);
  });

  it('Library/보관함 tab owns /library, /favorites and /history (merged hub)', () => {
    const saved = BOTTOM_TABS.find((t) => t.href === '/library')!;
    expect(saved.matches('/library')).toBe(true);
    expect(saved.matches('/favorites')).toBe(true);
    expect(saved.matches('/history')).toBe(true);
    expect(saved.matches('/history/2024')).toBe(true);
    expect(saved.matches('/')).toBe(false);
    expect(saved.matches('/search')).toBe(false);
  });

  it('Search tab matches /search and its query routes', () => {
    const search = BOTTOM_TABS.find((t) => t.href === '/search')!;
    expect(search.matches('/search')).toBe(true);
    expect(search.matches('/settings')).toBe(false);
  });

  it('Settings tab matches /settings', () => {
    const settings = BOTTOM_TABS.find((t) => t.href === '/settings')!;
    expect(settings.matches('/settings')).toBe(true);
    expect(settings.matches('/')).toBe(false);
  });
});

describe('navItems — desktop isNavActive', () => {
  it("treats '/' as exact match", () => {
    expect(isNavActive('/', '/')).toBe(true);
    expect(isNavActive('/favorites', '/')).toBe(false);
  });

  it('prefix-matches non-root hrefs', () => {
    expect(isNavActive('/favorites', '/favorites')).toBe(true);
    expect(isNavActive('/library/x', '/library')).toBe(true);
    expect(isNavActive('/settings', '/favorites')).toBe(false);
  });

  it('keeps the original 5 desktop destinations', () => {
    expect(NAV_ITEMS.map((n) => n.href)).toEqual([
      '/',
      '/favorites',
      '/history',
      '/library',
      '/settings',
    ]);
  });
});

describe('navItems — root vs stacked route classification', () => {
  it('treats the tab destinations as root (tab bar)', () => {
    expect(isRootTab('/', false)).toBe(true);
    expect(isRootTab('/library', false)).toBe(true);
    expect(isRootTab('/favorites', false)).toBe(true);
    expect(isRootTab('/history', false)).toBe(true);
    expect(isRootTab('/settings', false)).toBe(true);
  });

  it('treats gallery detail and licenses as stacked', () => {
    expect(isStackedRoute('/gallery/123', false)).toBe(true);
    expect(isStackedRoute('/licenses', false)).toBe(true);
    expect(isRootTab('/gallery/123', false)).toBe(false);
  });

  it('splits /search on the presence of a query', () => {
    // entry (no q) is a root tab; results (q) is stacked
    expect(isStackedRoute('/search', false)).toBe(false);
    expect(isRootTab('/search', false)).toBe(true);
    expect(isStackedRoute('/search', true)).toBe(true);
    expect(isRootTab('/search', true)).toBe(false);
  });

  it('hasQuery only affects /search, not other routes', () => {
    // a stray q on a root route must not make it stacked
    expect(isStackedRoute('/', true)).toBe(false);
    expect(isStackedRoute('/library', true)).toBe(false);
    // and gallery stays stacked regardless of q
    expect(isStackedRoute('/gallery/9', true)).toBe(true);
  });
});
