import type { ReactNode } from 'react';
import type { TranslationKey } from '@/lib/i18n/translations';

/**
 * Single source of truth for navigation destinations, shared by the desktop
 * header nav (Header.tsx) and the mobile bottom tab bar (BottomNav.tsx).
 *
 * Desktop keeps its original 5 text links (browse/favorites/history/library +
 * settings). Mobile collapses to 4 tabs: Browse, Search, Library (보관함 — a
 * merged hub of favorites/history/downloads), Settings. History and Favorites
 * are reachable on mobile from inside the Library hub, so the Library tab is
 * "active" for any of /library, /favorites, /history.
 */

export interface NavItem {
  href: string;
  key: TranslationKey;
  /** Icon renderer — caller supplies sizing/color via className. */
  icon: (className: string) => ReactNode;
}

const homeIcon = (className: string) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className={className}>
    <path d="M3 9.75 12 3l9 6.75V21a.75.75 0 0 1-.75.75h-4.5v-7.5h-7.5v7.5h-4.5A.75.75 0 0 1 3 21V9.75z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const searchIcon = (className: string) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className={className}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const favoritesIcon = (className: string) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className={className}>
    <path d="m11.48 3.5 2.13 5.11a.56.56 0 0 0 .47.34l5.52.45c.5.04.7.66.32.99l-4.2 3.6a.56.56 0 0 0-.18.55l1.29 5.39a.56.56 0 0 1-.84.6l-4.73-2.88a.56.56 0 0 0-.58 0l-4.73 2.88a.56.56 0 0 1-.84-.6l1.29-5.39a.56.56 0 0 0-.18-.55l-4.2-3.6c-.38-.33-.18-.95.32-.99l5.52-.45a.56.56 0 0 0 .47-.34l2.13-5.11a.56.56 0 0 1 1.04 0z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const historyIcon = (className: string) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className={className}>
    <path d="M12 7v5l3 1.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const libraryIcon = (className: string) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className={className}>
    <path d="M4 4h4v16H4zM10 4h4v16h-4zM18 4l2 16-2 .25" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const savedIcon = (className: string) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className={className}>
    <path d="M6 3h12a1 1 0 0 1 1 1v16l-7-4-7 4V4a1 1 0 0 1 1-1z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const settingsIcon = (className: string) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className={className}>
    <path d="M19.14 12.94a7.55 7.55 0 0 0 .06-.94c0-.32-.03-.62-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.04 7.04 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.55-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.87a.5.5 0 0 0 .12.61l2.03 1.58a7.55 7.55 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.61l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.49.39 1.03.7 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.59-.24 1.13-.55 1.62-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.61z" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

/** Desktop header nav — preserves the original 5 destinations + order. */
export const NAV_ITEMS: NavItem[] = [
  { href: '/', key: 'nav.browse', icon: homeIcon },
  { href: '/favorites', key: 'nav.favorites', icon: favoritesIcon },
  { href: '/history', key: 'nav.history', icon: historyIcon },
  { href: '/library', key: 'nav.library', icon: libraryIcon },
  { href: '/settings', key: 'nav.settings', icon: settingsIcon },
];

/** Mobile bottom tab bar — 4 tabs. `matches` decides the active tab from the
 *  current pathname (Library owns favorites/history too, since they live in
 *  its hub on mobile). */
export interface BottomTab extends NavItem {
  matches: (pathname: string) => boolean;
}

export const BOTTOM_TABS: BottomTab[] = [
  { href: '/', key: 'nav.browse', icon: homeIcon, matches: (p) => p === '/' },
  { href: '/search', key: 'nav.search', icon: searchIcon, matches: (p) => p.startsWith('/search') },
  {
    href: '/library',
    key: 'nav.saved',
    icon: savedIcon,
    matches: (p) => p.startsWith('/library') || p.startsWith('/favorites') || p.startsWith('/history'),
  },
  { href: '/settings', key: 'nav.settings', icon: settingsIcon, matches: (p) => p.startsWith('/settings') },
];

/** Desktop prefix-match active state ('/' is exact). */
export function isNavActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}
