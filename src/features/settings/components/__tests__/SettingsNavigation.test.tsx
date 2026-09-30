// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { useSettingsStore, type Locale } from '@/lib/store/settings';
import { t } from '@/lib/i18n/translations';
import { SettingsNavigation, type SettingsSectionName } from '../SettingsNavigation';

const sections: SettingsSectionName[] = [
  'general',
  'reader',
  'content',
  'privacy',
  'storage',
  'about',
];

function sectionLink(section: SettingsSectionName) {
  const link = screen
    .getAllByRole('link')
    .find((candidate) => candidate.getAttribute('href') === `/settings/${section}`);
  expect(link).toBeDefined();
  return link!;
}

describe('SettingsNavigation', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en', readerMode: 'page', imageFormat: 'auto' });
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ locale: 'en', readerMode: 'page', imageFormat: 'auto' });
  });

  it.each<Locale>(['en', 'ko'])('offers all six localized section routes in %s', (locale) => {
    useSettingsStore.getState().setLocale(locale);
    render(<SettingsNavigation />);

    expect(screen.getAllByRole('link')).toHaveLength(6);
    for (const section of sections) {
      const link = sectionLink(section);
      expect(within(link).getByText(t(`settings.section.${section}`, locale))).toBeVisible();
      expect(link).not.toHaveAttribute('aria-current');
    }
    for (const group of ['experience', 'content', 'app'] as const) {
      expect(
        screen.getByRole('heading', { name: t(`settings.group.${group}`, locale) }),
      ).toBeVisible();
    }
  });

  it('updates the displayed locale and localized category names without remounting', () => {
    render(<SettingsNavigation />);
    expect(sectionLink('general')).toHaveTextContent(t('settings.locale.en', 'en'));

    act(() => useSettingsStore.getState().setLocale('ko'));

    expect(sectionLink('general')).toHaveTextContent(t('settings.locale.ko', 'ko'));
    expect(sectionLink('general')).not.toHaveTextContent(t('settings.locale.en', 'en'));
    for (const section of sections) {
      expect(
        within(sectionLink(section)).getByText(t(`settings.section.${section}`, 'ko')),
      ).toBeVisible();
    }
  });

  it('updates the reader mode and image format summary from persisted preference actions', () => {
    render(<SettingsNavigation />);
    expect(sectionLink('reader')).toHaveTextContent(t('settings.reader.page', 'en'));
    expect(sectionLink('reader')).toHaveTextContent(/auto/i);

    act(() => useSettingsStore.getState().setReaderMode('scroll'));

    expect(sectionLink('reader')).toHaveTextContent(t('settings.reader.scroll', 'en'));
    expect(sectionLink('reader')).not.toHaveTextContent(t('settings.reader.page', 'en'));

    act(() => useSettingsStore.getState().setImageFormat('webp'));

    expect(sectionLink('reader')).toHaveTextContent(/webp/i);
    expect(sectionLink('reader')).not.toHaveTextContent(/auto/i);

    act(() => useSettingsStore.getState().setLocale('ko'));

    expect(sectionLink('reader')).toHaveTextContent(t('settings.reader.scroll', 'ko'));
    expect(sectionLink('reader')).toHaveTextContent(/webp/i);
  });

  it.each(sections)('marks only %s as the current section in category navigation', (current) => {
    render(<SettingsNavigation current={current} />);

    expect(screen.getAllByRole('link')).toHaveLength(6);
    for (const section of sections) {
      const link = sectionLink(section);
      expect(within(link).getByText(t(`settings.section.${section}`, 'en'))).toBeVisible();
      if (section === current) {
        expect(link).toHaveAttribute('aria-current', 'page');
      } else {
        expect(link).not.toHaveAttribute('aria-current');
      }
    }
  });
});
