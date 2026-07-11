// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useSettingsStore } from '@/lib/store/settings';
import { useTagI18nStore } from '@/lib/store/tag-i18n';
import { toFavoriteTagKey } from '@/lib/utils/tag-favorites';
import { TagType } from '@/lib/utils/types';
import { TagChip } from '../TagChip';

describe('TagChip', () => {
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

  it('renders the English tag name by default', () => {
    render(<TagChip tag="big breasts" type={TagType.FEMALE} linked={false} />);

    expect(screen.getByText('big breasts ♀')).toBeInTheDocument();
  });

  it('shows a non-interactive filled-star indicator for a favorite tag', () => {
    const key = toFavoriteTagKey(TagType.ARTIST, 'favorite artist');
    useSettingsStore.setState({ favoriteTags: [key] });

    render(<TagChip tag="favorite artist" type={TagType.ARTIST} />);

    const chip = screen.getByRole('link');
    expect(chip).toHaveAttribute('data-favorite', 'true');
    const favoriteIndicator = chip.querySelector('[data-favorite-indicator]');
    expect(favoriteIndicator).toHaveTextContent('★');
    expect(favoriteIndicator).toHaveClass('text-current', 'opacity-80');
    expect(favoriteIndicator).not.toHaveClass('text-amber-500', 'dark:text-amber-400');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('matches a legacy generic female suffix to the canonical female favorite', () => {
    const key = toFavoriteTagKey(TagType.FEMALE, 'legacy tag');
    useSettingsStore.setState({ favoriteTags: [key] });

    render(<TagChip tag="legacy tag ♀" type={TagType.TAG} linked={false} />);

    const chip = screen.getByText(/legacy tag/);
    expect(chip).toHaveAttribute('data-tag-key', key);
    expect(chip).toHaveAttribute('data-favorite', 'true');
  });

  it('matches favorite identity regardless of case and surrounding whitespace', () => {
    const key = toFavoriteTagKey(TagType.ARTIST, 'favorite artist');
    useSettingsStore.setState({ favoriteTags: [key] });

    const { container } = render(
      <TagChip tag="  FAVORITE Artist  " type={TagType.ARTIST} linked={false} />,
    );

    const chip = container.querySelector('[data-tag-key]');
    expect(chip).toHaveAttribute('data-tag-key', key);
    expect(chip).toHaveAttribute('data-favorite', 'true');
  });

  it('keeps regular chips on one line by default', () => {
    render(<TagChip tag="big breasts" type={TagType.FEMALE} linked={false} />);

    expect(screen.getByText('big breasts ♀')).toHaveClass('whitespace-nowrap');
  });

  it('can wrap long labels inside constrained suggestion rows', () => {
    render(
      <TagChip
        tag="love live! nijigasaki high school idol club"
        type={TagType.SERIES}
        displayName="러브 라이브! 니지가사키 학원 스쿨 아이돌 동호회"
        linked={false}
        wrap
      />,
    );

    const chip = screen.getByText('러브 라이브! 니지가사키 학원 스쿨 아이돌 동호회');
    expect(chip).toHaveClass('min-w-0', 'max-w-full', 'whitespace-normal', 'break-words');
    expect(chip).toHaveStyle({ overflowWrap: 'anywhere' });
  });

  it('renders the Korean tag name when Korean locale translations are loaded', () => {
    useSettingsStore.setState({ locale: 'ko' });
    useTagI18nStore.setState({
      isLoaded: true,
      loadedLocale: 'ko',
      nameToLocal: new Map([['female:big breasts', '거유']]),
    });

    render(<TagChip tag="big breasts" type={TagType.FEMALE} linked={false} />);

    expect(screen.getByText('거유 ♀')).toBeInTheDocument();
  });

  it('links to the Korean type-qualified query under Korean locale', () => {
    useSettingsStore.setState({ locale: 'ko' });
    useTagI18nStore.setState({
      isLoaded: true,
      loadedLocale: 'ko',
      nameToLocal: new Map([['female:big breasts', '거유']]),
    });

    render(<TagChip tag="big breasts" type={TagType.FEMALE} />);

    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      `/search?q=${encodeURIComponent('여자:거유')}`,
    );
  });

  it('links to the canonical English query under English locale', () => {
    // beforeEach sets locale 'en'.
    render(<TagChip tag="big breasts" type={TagType.FEMALE} />);

    expect(screen.getByRole('link')).toHaveAttribute('href', '/search?q=female%3Abig_breasts');
  });

  it('falls back to the English query when no Korean translation exists', () => {
    useSettingsStore.setState({ locale: 'ko' });
    // i18n store left empty by beforeEach — no Korean name for this tag.
    render(<TagChip tag="big breasts" type={TagType.FEMALE} />);

    expect(screen.getByRole('link')).toHaveAttribute('href', '/search?q=female%3Abig_breasts');
  });

  it('renders translated type tags in Korean locale', () => {
    useSettingsStore.setState({ locale: 'ko' });
    useTagI18nStore.setState({
      isLoaded: true,
      loadedLocale: 'ko',
      nameToLocal: new Map([['type:image set', '이미지 세트']]),
    });

    render(<TagChip tag="image set" type={TagType.TYPE} linked={false} />);

    expect(screen.getByText('이미지 세트')).toBeInTheDocument();
  });

  it('renders translated language tags in Korean locale', () => {
    useSettingsStore.setState({ locale: 'ko' });
    useTagI18nStore.setState({
      isLoaded: true,
      loadedLocale: 'ko',
      nameToLocal: new Map([['language:English', '영어']]),
    });

    render(<TagChip tag="English" type={TagType.LANGUAGE} linked={false} />);

    expect(screen.getByText('영어')).toBeInTheDocument();
  });
});
