// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useSettingsStore } from '@/lib/store/settings';
import { useTagI18nStore } from '@/lib/store/tag-i18n';
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
    useSettingsStore.setState({ locale: 'en' });
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
});
