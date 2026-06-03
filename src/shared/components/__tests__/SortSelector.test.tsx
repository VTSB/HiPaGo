// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

let mockIsMobile = true;
vi.mock('@/shared/hooks/useIsMobile', () => ({ useIsMobile: () => mockIsMobile }));
vi.mock('@/lib/i18n/useT', () => ({ useT: () => (k: string) => k }));

// jsdom lacks matchMedia; SortSheet reads prefers-reduced-motion.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

import { SortSelector } from '../SortSelector';

describe('SortSelector — mobile bottom sheet', () => {
  beforeEach(() => {
    mockIsMobile = true;
    cleanup();
  });

  it('renders a chip showing the current sort label', () => {
    render(<SortSelector value="popular_week" onChange={() => {}} />);
    const chip = screen.getByRole('button', { name: /sort\.popular_week/ });
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('opens a sheet and calls onChange with the chosen SortOrder', () => {
    const onChange = vi.fn();
    render(<SortSelector value="date_added" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /sort\.date_added/ }));
    // Sheet dialog is now open.
    expect(screen.getByRole('dialog')).toBeTruthy();
    // Click the label span so the event bubbles to the option's <button>.
    fireEvent.click(screen.getByText('sort.popular_month'));
    expect(onChange).toHaveBeenCalledWith('popular_month');
  });

  it('marks the active option as selected in the sheet', () => {
    render(<SortSelector value="popular_day" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /sort\.popular_day/ }));
    const active = screen.getByRole('option', { selected: true });
    expect(active.textContent).toMatch(/sort\.popular_day/);
  });
});

describe('SortSelector — desktop dropdown', () => {
  beforeEach(() => {
    mockIsMobile = false;
    cleanup();
  });

  it('does not render the mobile chip/sheet on desktop', () => {
    render(<SortSelector value="date_added" onChange={() => {}} />);
    // The mobile chip carries aria-haspopup="dialog"; the desktop Select must not.
    const dialogTrigger = screen
      .queryAllByRole('button')
      .find((b) => b.getAttribute('aria-haspopup') === 'dialog');
    expect(dialogTrigger).toBeUndefined();
  });
});
