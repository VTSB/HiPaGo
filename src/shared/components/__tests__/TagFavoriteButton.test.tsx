// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '@/lib/store/settings';
import { toFavoriteTagKey } from '@/lib/utils/tag-favorites';
import { TagType } from '@/lib/utils/types';
import { TagFavoriteButton } from '../TagFavoriteButton';

describe('TagFavoriteButton', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en', favoriteTags: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('toggles the canonical metadata favorite and exposes pressed state', () => {
    const key = toFavoriteTagKey(TagType.ARTIST, 'sample artist');
    render(<TagFavoriteButton tag="sample artist" type={TagType.ARTIST} />);

    const button = screen.getByRole('button', { name: /Add to Favorites: sample artist/ });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(button).toHaveAttribute('data-tag-favorite-key', key);

    fireEvent.click(button);

    expect(useSettingsStore.getState().favoriteTags).toEqual([key]);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button.querySelector('svg')).toHaveAttribute('fill', 'currentColor');

    fireEvent.click(button);

    expect(useSettingsStore.getState().favoriteTags).toEqual([]);
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('does not activate surrounding mouse or click handlers', () => {
    const onMouseDown = vi.fn();
    const onClick = vi.fn();
    render(
      <div onMouseDown={onMouseDown} onClick={onClick}>
        <TagFavoriteButton tag="standalone" type={TagType.TAG} />
      </div>,
    );

    const button = screen.getByRole('button');
    fireEvent.mouseDown(button);
    fireEvent.click(button);

    expect(onMouseDown).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('can receive Tab focus and toggle through native keyboard activation', () => {
    const key = toFavoriteTagKey(TagType.ARTIST, 'keyboard artist');
    render(
      <>
        <input aria-label="search" />
        <TagFavoriteButton tag="keyboard artist" type={TagType.ARTIST} />
      </>,
    );
    const input = screen.getByRole('textbox', { name: 'search' });
    const button = screen.getByRole('button', {
      name: 'Add to Favorites: keyboard artist',
    });

    input.focus();
    fireEvent.keyDown(input, { key: 'Tab', code: 'Tab' });
    input.blur();
    button.focus();
    expect(button).toHaveFocus();

    // Browsers dispatch click for Enter/Space activation on native buttons.
    fireEvent.keyDown(button, { key: 'Enter', code: 'Enter' });
    fireEvent.click(button);

    expect(useSettingsStore.getState().favoriteTags).toEqual([key]);
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });
});
