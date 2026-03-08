// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { RecentSearchesDropdown } from '../RecentSearchesDropdown';

vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('@/lib/utils/types', () => ({
  getTagColor: (type: string) => `bg-${type}-100`,
  TAG_TYPE_DISPLAY: { female: ' ♀', male: ' ♂', tag: '', artist: '', character: '', group: '', series: '', type: '', language: '' } as Record<string, string>,
}));

const SEARCHES = ['female:loli', 'tag:cute solo', 'artist:abc'];

function setup(props: Partial<React.ComponentProps<typeof RecentSearchesDropdown>> = {}) {
  const onSelect = vi.fn();
  const onRemove = vi.fn();
  const onClear = vi.fn();
  const { container } = render(
    <RecentSearchesDropdown
      searches={SEARCHES}
      onSelect={onSelect}
      onRemove={onRemove}
      onClear={onClear}
      {...props}
    />,
  );
  const items = () => container.querySelectorAll<HTMLElement>('[role="button"]');
  return { container, onSelect, onRemove, onClear, items };
}

describe('RecentSearchesDropdown', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  it('renders one row per search entry', () => {
    const { items } = setup();
    expect(items()).toHaveLength(SEARCHES.length);
  });

  // -------------------------------------------------------------------------
  // selectedIndex highlighting
  // Note: every row always has `hover:bg-zinc-100` for the hover state.
  // The active-selection highlight adds `bg-zinc-100` as a plain token (no prefix).
  // We split className by spaces to check for the exact standalone token.
  // -------------------------------------------------------------------------

  const hasHighlight = (el: HTMLElement) => el.className.split(' ').includes('bg-zinc-100');

  it('highlights no row when selectedIndex is -1 (default)', () => {
    const { items } = setup({ selectedIndex: -1 });
    items().forEach((item) => {
      expect(hasHighlight(item)).toBe(false);
    });
  });

  it('highlights the row at selectedIndex=0', () => {
    const { items } = setup({ selectedIndex: 0 });
    const rows = items();
    expect(hasHighlight(rows[0])).toBe(true);
    expect(hasHighlight(rows[1])).toBe(false);
    expect(hasHighlight(rows[2])).toBe(false);
  });

  it('highlights the row at selectedIndex=1', () => {
    const { items } = setup({ selectedIndex: 1 });
    const rows = items();
    expect(hasHighlight(rows[0])).toBe(false);
    expect(hasHighlight(rows[1])).toBe(true);
    expect(hasHighlight(rows[2])).toBe(false);
  });

  it('highlights the last row when selectedIndex equals searches.length - 1', () => {
    const { items } = setup({ selectedIndex: SEARCHES.length - 1 });
    const rows = items();
    expect(hasHighlight(rows[SEARCHES.length - 1])).toBe(true);
    for (let i = 0; i < SEARCHES.length - 1; i++) {
      expect(hasHighlight(rows[i])).toBe(false);
    }
  });

  it('highlights nothing when selectedIndex is out of range', () => {
    const { items } = setup({ selectedIndex: 99 });
    items().forEach((item) => {
      expect(hasHighlight(item)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  it('calls onSelect with the search string when a row is clicked', () => {
    const { items, onSelect } = setup();
    fireEvent.mouseDown(items()[0]);
    expect(onSelect).toHaveBeenCalledWith(SEARCHES[0]);
  });

  it('calls onSelect with correct string for middle row', () => {
    const { items, onSelect } = setup();
    fireEvent.mouseDown(items()[1]);
    expect(onSelect).toHaveBeenCalledWith(SEARCHES[1]);
  });

  it('calls onRemove and does NOT call onSelect when remove button is clicked', () => {
    const { container, onSelect, onRemove } = setup();
    const removeBtns = container.querySelectorAll<HTMLButtonElement>('button[type="button"]');
    // First button is "clear all"; remaining are per-item remove buttons
    // The clear button is in the header; item remove buttons come after
    // Find one that is NOT the clear button (no text content matching i18n key)
    const itemRemoveBtn = Array.from(removeBtns).find(
      (btn) => !btn.textContent?.includes('clearHistory'),
    )!;
    fireEvent.mouseDown(itemRemoveBtn);
    expect(onRemove).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('calls onClear when the clear-all button is clicked', () => {
    const { container, onClear } = setup();
    const clearBtn = container.querySelector<HTMLButtonElement>('button[type="button"]')!;
    fireEvent.mouseDown(clearBtn);
    expect(onClear).toHaveBeenCalled();
  });

  it('calls onSelect via keyboard Enter on a row', () => {
    const { items, onSelect } = setup();
    fireEvent.keyDown(items()[2], { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(SEARCHES[2]);
  });

  it('calls onSelect via keyboard Space on a row', () => {
    const { items, onSelect } = setup();
    fireEvent.keyDown(items()[0], { key: ' ' });
    expect(onSelect).toHaveBeenCalledWith(SEARCHES[0]);
  });
});
