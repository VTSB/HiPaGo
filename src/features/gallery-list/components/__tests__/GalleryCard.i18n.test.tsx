// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useSettingsStore } from '@/lib/store/settings';
import { useTagI18nStore } from '@/lib/store/tag-i18n';
import { toFavoriteTagKey } from '@/lib/utils/tag-favorites';
import { GalleryBlockType, TagType } from '@/lib/utils/types';
import type { GalleryBlock } from '@/lib/utils/types';
import { GalleryCard } from '../GalleryCard';

function renderCard(block: GalleryBlock) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <GalleryCard block={block} />
    </QueryClientProvider>,
  );
}

function makeBlock(): GalleryBlock {
  return {
    id: 100,
    type: GalleryBlockType.NOT_DETAILED,
    title: 'Sample',
    date: new Date('2026-01-01T00:00:00Z'),
    tags: {
      [TagType.TYPE]: ['image set'],
      [TagType.LANGUAGE]: ['English'],
      [TagType.FEMALE]: ['big breasts'],
      [TagType.SERIES]: ['uma musume pretty derby'],
    },
    thumbnail: '',
    related: [],
  };
}

describe('GalleryCard tag i18n', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en', favoriteTags: [] });
    useTagI18nStore.setState({
      isLoaded: false,
      loadedLocale: null,
      nameToLocal: new Map(),
      localToNames: new Map(),
      searchIndex: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders English tag names when locale is English', () => {
    renderCard(makeBlock());

    expect(screen.getByText('image set')).toBeInTheDocument();
    expect(screen.getByText('English')).toBeInTheDocument();
    expect(screen.getByText('big breasts ♀')).toBeInTheDocument();
  });

  it('renders translated tag names when locale is Korean', () => {
    useSettingsStore.setState({ locale: 'ko' });
    useTagI18nStore.setState({
      isLoaded: true,
      loadedLocale: 'ko',
      nameToLocal: new Map([
        ['type:image set', '이미지 세트'],
        ['language:English', '영어'],
        ['female:big breasts', '거유'],
      ]),
    });

    renderCard(makeBlock());

    expect(screen.getByText('이미지 세트')).toBeInTheDocument();
    expect(screen.getByText('영어')).toBeInTheDocument();
    expect(screen.getByText('거유 ♀')).toBeInTheDocument();
    expect(screen.getByText('uma musume pretty derby')).toBeInTheDocument();
  });

  it('shows favorite metadata before the existing card tag priority', () => {
    const favoriteKey = toFavoriteTagKey(TagType.SERIES, 'uma musume pretty derby');
    useSettingsStore.setState({ favoriteTags: [favoriteKey] });

    const { container } = renderCard(makeBlock());
    const renderedKeys = Array.from(container.querySelectorAll('[data-tag-key]')).map((tag) =>
      tag.getAttribute('data-tag-key'),
    );

    expect(renderedKeys[0]).toBe(favoriteKey);
    expect(container.querySelector(`[data-tag-key="${favoriteKey}"]`)).toHaveAttribute(
      'data-favorite',
      'true',
    );
  });

  it('prioritizes a legacy generic gender tag using its canonical favorite key', () => {
    const favoriteKey = toFavoriteTagKey(TagType.FEMALE, 'legacy tag');
    useSettingsStore.setState({ favoriteTags: [favoriteKey] });
    const block = makeBlock();
    block.tags = {
      [TagType.ARTIST]: ['priority artist'],
      [TagType.TAG]: ['legacy tag ♀', 'ordinary tag'],
    };

    const { container } = renderCard(block);
    const renderedKeys = Array.from(container.querySelectorAll('[data-tag-key]')).map((tag) =>
      tag.getAttribute('data-tag-key'),
    );

    expect(renderedKeys).toEqual([
      favoriteKey,
      toFavoriteTagKey(TagType.ARTIST, 'priority artist'),
      toFavoriteTagKey(TagType.TAG, 'ordinary tag'),
    ]);
  });
});
