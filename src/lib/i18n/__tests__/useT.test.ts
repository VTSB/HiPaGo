// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSettingsStore } from '@/lib/store/settings';
import { useT } from '../useT';

describe('useT', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' });
  });

  it('returns a function when called', () => {
    const { result } = renderHook(() => useT());
    expect(typeof result.current).toBe('function');
  });

  it('translates keys to English when locale is en', () => {
    useSettingsStore.setState({ locale: 'en' });
    const { result } = renderHook(() => useT());
    expect(result.current('nav.browse')).toBe('Browse');
    expect(result.current('nav.settings')).toBe('Settings');
    expect(result.current('search.placeholder')).toBe('Search tags... (Ctrl+K)');
  });

  it('translates keys to Korean when locale is ko', () => {
    useSettingsStore.setState({ locale: 'ko' });
    const { result } = renderHook(() => useT());
    expect(result.current('nav.browse')).toBe('둘러보기');
    expect(result.current('nav.settings')).toBe('설정');
    expect(result.current('search.placeholder')).toBe('태그 검색... (Ctrl+K)');
  });

  it('returns different translations for en vs ko', () => {
    useSettingsStore.setState({ locale: 'en' });
    const { result: enResult } = renderHook(() => useT());
    const enText = enResult.current('nav.favorites');

    useSettingsStore.setState({ locale: 'ko' });
    const { result: koResult } = renderHook(() => useT());
    const koText = koResult.current('nav.favorites');

    expect(enText).toBe('Favorites');
    expect(koText).toBe('즐겨찾기');
    expect(enText).not.toBe(koText);
  });

  it('returned function is stable across renders with same locale', () => {
    useSettingsStore.setState({ locale: 'en' });
    const { result, rerender } = renderHook(() => useT());
    const firstFn = result.current;
    rerender();
    expect(result.current).toBe(firstFn);
  });

  it('returned function changes when locale changes', () => {
    useSettingsStore.setState({ locale: 'en' });
    const { result: r1 } = renderHook(() => useT());
    const fnEn = r1.current;

    useSettingsStore.setState({ locale: 'ko' });
    const { result: r2 } = renderHook(() => useT());
    const fnKo = r2.current;

    expect(fnEn('nav.browse')).toBe('Browse');
    expect(fnKo('nav.browse')).toBe('둘러보기');
  });

  it('translates reader controls for en locale', () => {
    useSettingsStore.setState({ locale: 'en' });
    const { result } = renderHook(() => useT());
    expect(result.current('reader.prev')).toBe('Prev');
    expect(result.current('reader.next')).toBe('Next');
    expect(result.current('reader.scroll')).toBe('Scroll');
  });

  it('translates reader controls for ko locale', () => {
    useSettingsStore.setState({ locale: 'ko' });
    const { result } = renderHook(() => useT());
    expect(result.current('reader.prev')).toBe('이전');
    expect(result.current('reader.next')).toBe('다음');
    expect(result.current('reader.scroll')).toBe('스크롤');
  });

  it('translates settings keys for en locale', () => {
    useSettingsStore.setState({ locale: 'en' });
    const { result } = renderHook(() => useT());
    expect(result.current('settings.title')).toBe('Settings');
    expect(result.current('settings.locale')).toBe('System Language');
    expect(result.current('settings.theme')).toBe('Theme');
  });

  it('translates settings keys for ko locale', () => {
    useSettingsStore.setState({ locale: 'ko' });
    const { result } = renderHook(() => useT());
    expect(result.current('settings.title')).toBe('설정');
    expect(result.current('settings.locale')).toBe('시스템 언어');
    expect(result.current('settings.theme')).toBe('테마');
  });
});
