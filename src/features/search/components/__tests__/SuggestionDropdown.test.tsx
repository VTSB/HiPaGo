// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '@/lib/store/settings';
import { prioritizeSuggestions } from '@/lib/utils/tag-favorites';
import { TagType } from '@/lib/utils/types';
import type { Suggestion } from '@/lib/utils/types';
import { SuggestionDropdown } from '../SuggestionDropdown';

const suggestions: Suggestion[] = [{ tag: 'sample artist', tagType: TagType.ARTIST, amount: 1234 }];

describe('SuggestionDropdown', () => {
  const onSelect = vi.fn();
  const onHover = vi.fn();
  const ignoreMouseRef = { current: false };

  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ locale: 'en', favoriteTags: [] });
  });

  it('preserves option identity, selection styling, and label wrapping', () => {
    render(
      <SuggestionDropdown
        suggestions={suggestions}
        selectedIndex={0}
        onSelect={onSelect}
        onHover={onHover}
        ignoreMouseRef={ignoreMouseRef}
      />,
    );

    const option = document.querySelector('[data-search-option]') as HTMLElement;
    const row = option.parentElement!;

    expect(option).toHaveAttribute('id', 'search-option-0');
    expect(option).toHaveAttribute('aria-current', 'true');
    expect(row).toHaveClass('bg-zinc-100', 'dark:bg-zinc-700');
    expect(row.querySelector('[data-tag-favorite-chip]')).not.toBeNull();
    expect(screen.getByText('sample artist')).toHaveClass(
      'max-w-full',
      'whitespace-normal',
      'break-words',
    );
  });

  it('uses sibling native buttons and isolates favorite events from selection', () => {
    render(
      <SuggestionDropdown
        suggestions={suggestions}
        selectedIndex={-1}
        onSelect={onSelect}
        onHover={onHover}
        ignoreMouseRef={ignoreMouseRef}
      />,
    );

    const option = document.querySelector('[data-search-option]') as HTMLElement;
    const favoriteButton = screen.getByRole('button', {
      name: 'Add to Favorites: sample artist',
    });

    expect(option.parentElement).toContainElement(favoriteButton);
    expect(option).not.toContainElement(favoriteButton);
    expect(favoriteButton).toHaveAttribute('aria-pressed', 'false');

    favoriteButton.focus();
    expect(favoriteButton).toHaveFocus();
    fireEvent.keyDown(favoriteButton, { key: 'Enter', code: 'Enter' });
    fireEvent.mouseDown(favoriteButton);
    fireEvent.click(favoriteButton);

    expect(onSelect).not.toHaveBeenCalled();
    expect(favoriteButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: 'Search' })).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();

    fireEvent.mouseDown(option);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledWith('sample artist', TagType.ARTIST, undefined);
  });

  it('preserves favorite-button focus when its row moves to the front', () => {
    const rankedSuggestions: Suggestion[] = [
      { tag: 'regular artist', tagType: TagType.ARTIST, amount: 100 },
      { tag: 'favorite artist', tagType: TagType.ARTIST, amount: 1 },
    ];
    function FavoriteSortedDropdown() {
      const favoriteTags = useSettingsStore((state) => state.favoriteTags);
      return (
        <SuggestionDropdown
          suggestions={prioritizeSuggestions(rankedSuggestions, favoriteTags)}
          selectedIndex={-1}
          onSelect={onSelect}
          onHover={onHover}
          ignoreMouseRef={ignoreMouseRef}
        />
      );
    }

    const { container } = render(<FavoriteSortedDropdown />);
    const favoriteButton = screen.getByRole('button', {
      name: 'Add to Favorites: favorite artist',
    });
    favoriteButton.focus();
    fireEvent.keyDown(favoriteButton, { key: ' ', code: 'Space' });
    fireEvent.click(favoriteButton);

    expect(favoriteButton).toHaveFocus();
    expect(container.querySelectorAll('[data-search-option]')[0]).toHaveTextContent(
      'favorite artist',
    );
  });
});
