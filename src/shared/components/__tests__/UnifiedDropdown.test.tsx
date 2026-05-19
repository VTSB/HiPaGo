// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnifiedDropdown, buildDropdownItems, type FlatItem } from '../UnifiedDropdown';
import type { Suggestion } from '@/lib/utils/types';
import { TagType } from '@/lib/utils/types';

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// Mock useSettingsStore so useT works without localStorage
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (selector: (s: { locale: 'en' }) => unknown) =>
    selector({ locale: 'en' }),
}));

const mockSuggestions: Suggestion[] = [
  { tag: 'loli', tagType: TagType.FEMALE, amount: 45678 },
  { tag: 'stockings', tagType: TagType.FEMALE, amount: 8901 },
];

const mockRecent = ['female:loli artist:yam', 'series:one_piece'];

const mockPopular: Suggestion[] = [
  { tag: 'schoolgirl', tagType: TagType.FEMALE, amount: 100000 },
];

// ----------- buildDropdownItems tests -----------

describe('buildDropdownItems', () => {
  it('includes recent searches when available', () => {
    const items = buildDropdownItems({
      inputText: '',
      recentSearches: mockRecent,
      suggestions: [],
      popularTags: [],
    });
    const recents = items.filter((i) => i.kind === 'recent');
    expect(recents).toHaveLength(2);
    expect(recents[0]).toEqual({ kind: 'recent', query: 'female:loli artist:yam' });
  });

  it('filters recent searches by inputText', () => {
    const items = buildDropdownItems({
      inputText: 'loli',
      recentSearches: mockRecent,
      suggestions: [],
      popularTags: [],
    });
    const recents = items.filter((i) => i.kind === 'recent');
    expect(recents).toHaveLength(1);
    expect(recents[0]).toEqual({ kind: 'recent', query: 'female:loli artist:yam' });
  });

  it('limits recent searches to 3 when filtering', () => {
    const many = ['one piece', 'two piece', 'three piece', 'four piece', 'five piece'];
    const items = buildDropdownItems({
      inputText: 'piece',
      recentSearches: many,
      suggestions: [],
      popularTags: [],
    });
    const recents = items.filter((i) => i.kind === 'recent');
    expect(recents).toHaveLength(3);
  });

  it('limits recent searches to 5 when not filtering', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'];
    const items = buildDropdownItems({
      inputText: '',
      recentSearches: many,
      suggestions: [],
      popularTags: [],
    });
    const recents = items.filter((i) => i.kind === 'recent');
    expect(recents).toHaveLength(5);
  });

  it('includes tag suggestions when available', () => {
    const items = buildDropdownItems({
      inputText: 'lo',
      recentSearches: [],
      suggestions: mockSuggestions,
      popularTags: [],
    });
    const sugs = items.filter((i) => i.kind === 'suggestion');
    expect(sugs).toHaveLength(2);
  });

  it('shows popular tags when inputText is empty', () => {
    const items = buildDropdownItems({
      inputText: '',
      recentSearches: [],
      suggestions: [],
      popularTags: mockPopular,
    });
    const sugs = items.filter((i) => i.kind === 'suggestion');
    expect(sugs).toHaveLength(1);
    expect(sugs[0]).toEqual({ kind: 'suggestion', suggestion: mockPopular[0] });
  });

  it('does NOT show popular tags when inputText is non-empty', () => {
    const items = buildDropdownItems({
      inputText: 'something',
      recentSearches: [],
      suggestions: [],
      popularTags: mockPopular,
    });
    const sugs = items.filter((i) => i.kind === 'suggestion');
    expect(sugs).toHaveLength(0);
  });

  it('returns empty array when no content', () => {
    const items = buildDropdownItems({
      inputText: '',
      recentSearches: [],
      suggestions: [],
      popularTags: [],
    });
    expect(items).toHaveLength(0);
  });

  it('prefers suggestions over popular tags', () => {
    const items = buildDropdownItems({
      inputText: '',
      recentSearches: [],
      suggestions: mockSuggestions,
      popularTags: mockPopular,
    });
    const sugs = items.filter((i) => i.kind === 'suggestion');
    // suggestions win — popular tags NOT shown
    expect(sugs).toHaveLength(2);
    expect(sugs[0]).toEqual({ kind: 'suggestion', suggestion: mockSuggestions[0] });
  });
});

// ----------- UnifiedDropdown component tests -----------

describe('UnifiedDropdown', () => {
  const recentItems: FlatItem[] = [
    { kind: 'recent', query: 'female:loli artist:yam' },
    { kind: 'recent', query: 'series:one_piece' },
  ];
  const suggestionItems: FlatItem[] = [
    { kind: 'suggestion', suggestion: mockSuggestions[0] },
    { kind: 'suggestion', suggestion: mockSuggestions[1] },
  ];
  const mixedItems: FlatItem[] = [...recentItems, ...suggestionItems];

  const baseProps = {
    selectedIndex: -1,
    onSelectRecent: vi.fn(),
    onSelectSuggestion: vi.fn(),
    onRemoveRecent: vi.fn(),
    onClearRecents: vi.fn(),
    onHover: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows recent searches section header', () => {
    render(<UnifiedDropdown {...baseProps} flatItems={recentItems} />);
    expect(screen.getByText('Recent Searches')).toBeInTheDocument();
  });

  it('shows tag suggestions section header', () => {
    render(<UnifiedDropdown {...baseProps} flatItems={suggestionItems} />);
    expect(screen.getByText('Tag Suggestions')).toBeInTheDocument();
  });

  it('hides recent section when no recent items', () => {
    render(<UnifiedDropdown {...baseProps} flatItems={suggestionItems} />);
    expect(screen.queryByText('Recent Searches')).not.toBeInTheDocument();
  });

  it('hides suggestion section when no suggestion items', () => {
    render(<UnifiedDropdown {...baseProps} flatItems={recentItems} />);
    expect(screen.queryByText('Tag Suggestions')).not.toBeInTheDocument();
  });

  it('highlights selected item by index', () => {
    const { container } = render(
      <UnifiedDropdown {...baseProps} flatItems={recentItems} selectedIndex={0} />,
    );
    // The selected row gets dark:bg-zinc-700 — check for the class string substring
    const rows = container.querySelectorAll('[role="button"]');
    expect(rows[0].className).toMatch(/bg-zinc-700/);
  });

  it('uses onMouseDown on the clear-all button (not onClick)', () => {
    render(<UnifiedDropdown {...baseProps} flatItems={recentItems} />);
    // Find clear-all button: it should NOT have an onClick handler
    const clearBtn = screen.getByText('Clear all');
    // Verify it responds to mousedown
    fireEvent.mouseDown(clearBtn);
    expect(baseProps.onClearRecents).toHaveBeenCalledTimes(1);
  });

  it('clicking recent search calls onSelectRecent', () => {
    const { container } = render(<UnifiedDropdown {...baseProps} flatItems={recentItems} />);
    // Recent rows are div[role="button"], not <button> elements
    const rows = container.querySelectorAll('[role="button"]');
    fireEvent.mouseDown(rows[0]);
    const firstRecent = recentItems[0] as { kind: 'recent'; query: string };
    expect(baseProps.onSelectRecent).toHaveBeenCalledWith(firstRecent.query);
  });

  it('clicking suggestion calls onSelectSuggestion', () => {
    render(<UnifiedDropdown {...baseProps} flatItems={suggestionItems} />);
    // Suggestion buttons have role="option" (inside a listbox)
    const options = screen.getAllByRole('option');
    fireEvent.mouseDown(options[0]);
    expect(baseProps.onSelectSuggestion).toHaveBeenCalledWith(
      mockSuggestions[0].tag,
      mockSuggestions[0].tagType,
      mockSuggestions[0].localName,
    );
  });

  it('clear all button calls onClearRecents', () => {
    render(<UnifiedDropdown {...baseProps} flatItems={recentItems} />);
    fireEvent.mouseDown(screen.getByText('Clear all'));
    expect(baseProps.onClearRecents).toHaveBeenCalledTimes(1);
  });

  it('recent search delete button calls onRemoveRecent', () => {
    const { container } = render(<UnifiedDropdown {...baseProps} flatItems={recentItems} />);
    // Each recent row div[role="button"] contains a child <button> (the delete X)
    const recentRows = container.querySelectorAll('[role="button"]');
    const deleteBtn = recentRows[0].querySelector('button');
    expect(deleteBtn).not.toBeNull();
    fireEvent.mouseDown(deleteBtn!);
    const firstRecent2 = recentItems[0] as { kind: 'recent'; query: string };
    expect(baseProps.onRemoveRecent).toHaveBeenCalledWith(firstRecent2.query);
  });

  it('renders with dark mode container styling', () => {
    const { container } = render(<UnifiedDropdown {...baseProps} flatItems={mixedItems} />);
    const dropdown = container.firstChild as HTMLElement;
    expect(dropdown.className).toMatch(/bg-white/);
    expect(dropdown.className).toMatch(/dark:bg-zinc-800/);
  });
});
