import type { ReactNode } from 'react';
import type { TranslationKey } from '@/lib/i18n/translations';

/** Shared destinations and route ownership for desktop and mobile navigation. */
export interface NavItem {
  href: string;
  key: TranslationKey;
  /** Icon renderer — caller supplies sizing/color via className. */
  icon: (className: string) => ReactNode;
}

const homeIcon = (className: string) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    className={className}
  >
    <path
      d="M3 9.75 12 3l9 6.75V21a.75.75 0 0 1-.75.75h-4.5v-7.5h-7.5v7.5h-4.5A.75.75 0 0 1 3 21V9.75z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const searchIcon = (className: string) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    className={className}
  >
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const savedIcon = (className: string) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    className={className}
  >
    <path
      d="M6 3h12a1 1 0 0 1 1 1v16l-7-4-7 4V4a1 1 0 0 1 1-1z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const moreIcon = (className: string) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
  >
    <circle cx="5" cy="12" r="2" />
    <circle cx="12" cy="12" r="2" />
    <circle cx="19" cy="12" r="2" />
  </svg>
);

export interface BottomTab extends NavItem {
  matches: (pathname: string) => boolean;
}

export const BOTTOM_TABS: BottomTab[] = [
  { href: '/', key: 'nav.browse', icon: homeIcon, matches: (p) => p === '/' },
  { href: '/search', key: 'nav.search', icon: searchIcon, matches: (p) => p === '/search' },
  {
    href: '/library',
    key: 'nav.saved',
    icon: savedIcon,
    matches: (p) => p === '/library' || p === '/favorites' || p === '/downloads',
  },
  {
    href: '/more',
    key: 'nav.more',
    icon: moreIcon,
    matches: (p) =>
      p === '/more' ||
      p === '/history' ||
      p === '/settings' ||
      p.startsWith('/settings/') ||
      p === '/licenses',
  },
];

export const NAV_ITEMS: NavItem[] = BOTTOM_TABS;

export function isNavActive(pathname: string, href: string): boolean {
  const tab = BOTTOM_TABS.find((item) => item.href === href);
  return tab ? tab.matches(pathname) : pathname === href || pathname.startsWith(`${href}/`);
}

/** Search results and secondary pages are pushed views with a back button. */
export function isStackedRoute(pathname: string, hasQuery: boolean): boolean {
  if (pathname === '/search') return hasQuery;
  return (
    pathname !== '/' && pathname !== '/library' && pathname !== '/favorites' && pathname !== '/more'
  );
}

export function isRootTab(pathname: string, hasQuery: boolean): boolean {
  return !isStackedRoute(pathname, hasQuery);
}
