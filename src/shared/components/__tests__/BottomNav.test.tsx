// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

let mockPathname = '/';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));
// useT returns the key so we can assert on stable labels.
vi.mock('@/lib/i18n/useT', () => ({ useT: () => (k: string) => k }));

import { BottomNav } from '../BottomNav';

describe('BottomNav', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders the 4 tab destinations', () => {
    mockPathname = '/';
    render(<BottomNav />);
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/',
      '/search',
      '/library',
      '/settings',
    ]);
  });

  it('marks the Browse tab active on the root path', () => {
    mockPathname = '/';
    render(<BottomNav />);
    const active = screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute('href')).toBe('/');
  });

  it('marks the Library tab active when on /favorites (merged hub)', () => {
    mockPathname = '/favorites';
    render(<BottomNav />);
    const active = screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute('href')).toBe('/library');
  });

  it('marks the Library tab active when on /history (merged hub)', () => {
    mockPathname = '/history';
    render(<BottomNav />);
    const active = screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(active[0].getAttribute('href')).toBe('/library');
  });

  it('marks the Search tab active on /search', () => {
    mockPathname = '/search';
    render(<BottomNav />);
    const active = screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(active[0].getAttribute('href')).toBe('/search');
  });
});
