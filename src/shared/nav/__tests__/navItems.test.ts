import { describe, it, expect } from 'vitest';
import { BOTTOM_TABS, NAV_ITEMS, isNavActive, isStackedRoute, isRootTab } from '../navItems';

describe('navItems — bottom tab set', () => {
  it('exposes exactly 4 mobile tabs in order', () => {
    expect(BOTTOM_TABS.map((t) => t.href)).toEqual(['/', '/search', '/library', '/more']);
  });

  it('Browse tab matches only the exact root', () => {
    const browse = BOTTOM_TABS[0];
    expect(browse.matches('/')).toBe(true);
    expect(browse.matches('/search')).toBe(false);
    expect(browse.matches('/library')).toBe(false);
  });

  it('Library owns saved works and download management', () => {
    const saved = BOTTOM_TABS.find((t) => t.href === '/library')!;
    expect(saved.matches('/library')).toBe(true);
    expect(saved.matches('/favorites')).toBe(true);
    expect(saved.matches('/history')).toBe(false);
    expect(saved.matches('/downloads')).toBe(true);
    expect(saved.matches('/history/2024')).toBe(false);
    expect(saved.matches('/')).toBe(false);
    expect(saved.matches('/search')).toBe(false);
  });

  it('Search tab matches /search and its query routes', () => {
    const search = BOTTOM_TABS.find((t) => t.href === '/search')!;
    expect(search.matches('/search')).toBe(true);
    expect(search.matches('/settings')).toBe(false);
  });

  it('More tab owns settings and history', () => {
    const settings = BOTTOM_TABS.find((t) => t.href === '/more')!;
    expect(settings.matches('/settings')).toBe(true);
    expect(settings.matches('/settings/reader')).toBe(true);
    expect(settings.matches('/history')).toBe(true);
    expect(settings.matches('/downloads')).toBe(false);
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
    expect(isNavActive('/downloads', '/library')).toBe(true);
    expect(isNavActive('/settings', '/favorites')).toBe(false);
  });

  it('shares four desktop/mobile destinations', () => {
    expect(NAV_ITEMS.map((n) => n.href)).toEqual(['/', '/search', '/library', '/more']);
  });
});

describe('navItems — root vs stacked route classification', () => {
  it('treats the tab destinations as root (tab bar)', () => {
    expect(isRootTab('/', false)).toBe(true);
    expect(isRootTab('/library', false)).toBe(true);
    expect(isRootTab('/favorites', false)).toBe(true);
    expect(isRootTab('/more', false)).toBe(true);
    expect(isRootTab('/history', false)).toBe(false);
    expect(isRootTab('/settings', false)).toBe(false);
    expect(isRootTab('/settings/reader', false)).toBe(false);
    expect(isRootTab('/downloads', false)).toBe(false);
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
