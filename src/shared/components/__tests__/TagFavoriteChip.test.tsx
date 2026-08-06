// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '@/lib/store/settings';
import { TagType } from '@/lib/utils/types';
import { TagFavoriteChip } from '../TagFavoriteChip';

describe('TagFavoriteChip', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en', favoriteTags: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps the tag link and favorite toggle as siblings inside one chip surface', () => {
    const { container } = render(
      <TagFavoriteChip tag="sample artist" type={TagType.ARTIST} size="md" />,
    );

    const chip = container.querySelector('[data-tag-favorite-chip]');
    const link = screen.getByRole('link', { name: 'sample artist' });
    const favoriteButton = screen.getByRole('button', {
      name: 'Add to Favorites: sample artist',
    });

    expect(chip).toContainElement(link);
    expect(chip).toContainElement(favoriteButton);
    expect(link).not.toContainElement(favoriteButton);
    expect(container.querySelector('a button')).toBeNull();
    expect(favoriteButton).toHaveAttribute('data-chip-integrated');
    expect(favoriteButton).toHaveClass('text-current');
  });

  it('keeps label selection and favorite toggling independent without nested buttons', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <TagFavoriteChip tag="sample tag" type={TagType.TAG} linked={false} onSelect={onSelect} />,
    );

    const buttons = screen.getAllByRole('button');
    const labelButton = buttons.find((button) => button.textContent?.includes('sample tag'))!;
    const favoriteButton = screen.getByRole('button', {
      name: 'Add to Favorites: sample tag',
    });

    expect(container.querySelector('button button')).toBeNull();
    expect(labelButton).not.toContainElement(favoriteButton);
    expect(container.querySelector('[data-favorite-indicator]')).toBeNull();

    fireEvent.click(favoriteButton);
    expect(onSelect).not.toHaveBeenCalled();
    expect(favoriteButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(labelButton);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
