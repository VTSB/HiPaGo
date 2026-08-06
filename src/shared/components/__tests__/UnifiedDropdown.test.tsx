// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnifiedDropdown, buildDropdownItems, type FlatItem } from '../UnifiedDropdown';
import { useSettingsStore } from '@/lib/store/settings';
import { prioritizeSuggestions } from '@/lib/utils/tag-favorites';
import type { Suggestion } from '@/lib/utils/types';
import { TagType } from '@/lib/utils/types';

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockSuggestions: Suggestion[] = [
  { tag: 'loli', tagType: TagType.FEMALE, amount: 45678 },
  { tag: 'stockings', tagType: TagType.FEMALE, amount: 8901 },
];

const mockRecent = ['female:loli artist:yam', 'series:one_piece'];

const mockPopular: Suggestion[] = [{ tag: 'schoolgirl', tagType: TagType.FEMALE, amount: 100000 }];

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
    useSettingsStore.setState({ locale: 'en', favoriteTags: [] });
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
    const option = container.querySelector('[data-search-option]') as HTMLElement;
    expect(option.parentElement?.className).toMatch(/bg-zinc-700/);
    expect(option).toHaveAttribute('aria-current', 'true');
  });

  it('keeps focus on mouse-down and clears on native click activation', () => {
    render(<UnifiedDropdown {...baseProps} flatItems={recentItems} />);
    const clearBtn = screen.getByText('Clear all');
    fireEvent.mouseDown(clearBtn);
    expect(baseProps.onClearRecents).not.toHaveBeenCalled();
    fireEvent.click(clearBtn);
    expect(baseProps.onClearRecents).toHaveBeenCalledTimes(1);
  });

  it('clicking recent search calls onSelectRecent', () => {
    const { container } = render(<UnifiedDropdown {...baseProps} flatItems={recentItems} />);
    const rows = container.querySelectorAll('[data-search-option]');
    fireEvent.mouseDown(rows[0]);
    expect(baseProps.onSelectRecent).not.toHaveBeenCalled();
    fireEvent.click(rows[0]);
    const firstRecent = recentItems[0] as { kind: 'recent'; query: string };
    expect(baseProps.onSelectRecent).toHaveBeenCalledWith(firstRecent.query);
  });

  it('clicking suggestion calls onSelectSuggestion', () => {
    const { container } = render(<UnifiedDropdown {...baseProps} flatItems={suggestionItems} />);
    const options = container.querySelectorAll('[data-search-option]');
    fireEvent.mouseDown(options[0]);
    expect(baseProps.onSelectSuggestion).not.toHaveBeenCalled();
    fireEvent.click(options[0]);
    expect(baseProps.onSelectSuggestion).toHaveBeenCalledWith(
      mockSuggestions[0].tag,
      mockSuggestions[0].tagType,
      mockSuggestions[0].localName,
    );
  });

  it('keeps favorite toggling separate from suggestion selection', () => {
    render(<UnifiedDropdown {...baseProps} flatItems={suggestionItems} />);

    const option = document.querySelector('[data-search-option]') as HTMLElement;
    const favoriteButton = screen.getByRole('button', {
      name: 'Add to Favorites: loli',
    });

    expect(option.parentElement).toContainElement(favoriteButton);
    expect(option).not.toContainElement(favoriteButton);
    expect(favoriteButton).toHaveAttribute('aria-pressed', 'false');

    favoriteButton.focus();
    expect(favoriteButton).toHaveFocus();
    fireEvent.keyDown(favoriteButton, { key: 'Enter', code: 'Enter' });
    fireEvent.mouseDown(favoriteButton);
    fireEvent.click(favoriteButton);

    expect(baseProps.onSelectSuggestion).not.toHaveBeenCalled();
    expect(favoriteButton).toHaveAttribute('aria-pressed', 'true');
    expect(option).toBeInTheDocument();
  });

  it('preserves favorite-button focus when its row moves to the front', () => {
    function FavoriteSortedDropdown() {
      const favoriteTags = useSettingsStore((state) => state.favoriteTags);
      const sorted = prioritizeSuggestions(mockSuggestions, favoriteTags);
      return (
        <UnifiedDropdown
          {...baseProps}
          flatItems={sorted.map((suggestion) => ({ kind: 'suggestion', suggestion }))}
        />
      );
    }

    const { container } = render(<FavoriteSortedDropdown />);
    const favoriteButton = screen.getByRole('button', {
      name: 'Add to Favorites: stockings',
    });
    favoriteButton.focus();
    fireEvent.keyDown(favoriteButton, { key: ' ', code: 'Space' });
    fireEvent.click(favoriteButton);

    expect(favoriteButton).toHaveFocus();
    expect(container.querySelectorAll('[data-search-option]')[0]).toHaveTextContent('stockings');
  });

  it('allows long suggestion labels to wrap without widening the dropdown', () => {
    render(
      <UnifiedDropdown
        {...baseProps}
        flatItems={[
          {
            kind: 'suggestion',
            suggestion: {
              tagType: TagType.SERIES,
              tag: 'love live! nijigasaki high school idol club',
              localName: '러브 라이브! 니지가사키 학원 스쿨 아이돌 동호회',
              amount: 1444,
            },
          },
        ]}
        koreanDisplay
      />,
    );

    const option = document.querySelector('[data-search-option]') as HTMLElement;
    expect(option.parentElement).toHaveClass('min-w-0');
    expect(option.parentElement?.querySelector('[data-tag-favorite-chip]')).not.toBeNull();
    expect(screen.getByText('1,444')).toHaveClass('shrink-0', 'tabular-nums');

    const chip = screen.getByText('러브 라이브! 니지가사키 학원 스쿨 아이돌 동호회');
    expect(chip).toHaveClass('max-w-full', 'whitespace-normal', 'break-words');
    expect(chip).toHaveStyle({ overflowWrap: 'anywhere' });
  });

  it('clear all button calls onClearRecents', () => {
    render(<UnifiedDropdown {...baseProps} flatItems={recentItems} />);
    fireEvent.click(screen.getByText('Clear all'));
    expect(baseProps.onClearRecents).toHaveBeenCalledTimes(1);
  });

  it('recent search delete button calls onRemoveRecent', () => {
    render(<UnifiedDropdown {...baseProps} flatItems={recentItems} />);
    const deleteBtn = screen.getByRole('button', {
      name: 'Clear all: female:loli artist:yam',
    });
    fireEvent.mouseDown(deleteBtn);
    expect(baseProps.onRemoveRecent).not.toHaveBeenCalled();
    fireEvent.click(deleteBtn);
    const firstRecent2 = recentItems[0] as { kind: 'recent'; query: string };
    expect(baseProps.onRemoveRecent).toHaveBeenCalledWith(firstRecent2.query);
  });

  it('renders with dark mode container styling', () => {
    const { container } = render(<UnifiedDropdown {...baseProps} flatItems={mixedItems} />);
    const dropdown = container.firstChild as HTMLElement;
    expect(dropdown.className).toMatch(/bg-white/);
    expect(dropdown.className).toMatch(/dark:bg-zinc-800/);
  });

  it('uses a region with native sibling buttons instead of a composite listbox', () => {
    const { container } = render(<UnifiedDropdown {...baseProps} flatItems={suggestionItems} />);

    expect(screen.getByRole('region', { name: 'Search' })).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(container.querySelectorAll('[data-search-option]')).toHaveLength(2);
  });
});
