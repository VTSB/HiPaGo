import { describe, it, expect } from 'vitest';
import { BOTTOM_TABS, NAV_ITEMS, isNavActive } from '../navItems';

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
