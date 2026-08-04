// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useReaderHistory } from '../useReaderHistory';

describe('useReaderHistory', () => {
  afterEach(() => {
    delete window.__hipagoCanGoBack;
    window.history.replaceState(null, '', '/');
    vi.restoreAllMocks();
  });

  it('walks browser history for a normal reader session', () => {
    window.__hipagoCanGoBack = vi.fn(() => true);
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const { result } = renderHook(() => useReaderHistory(123));

    act(() => result.current.goBack());

    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the dynamic gallery detail when Android has no app history', () => {
    window.history.replaceState(null, '', '/gallery/123/reader');
    window.__hipagoCanGoBack = vi.fn(() => false);
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const popStateSpy = vi.fn();
    window.addEventListener('popstate', popStateSpy, { once: true });
    const { result } = renderHook(() => useReaderHistory(123));

    act(() => result.current.goBack());

    expect(backSpy).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/gallery/123');
    expect(popStateSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back on a cold browser deep-link with no history entry', () => {
    window.history.replaceState(null, '', '/gallery/456/reader');
    vi.spyOn(window.history, 'length', 'get').mockReturnValue(1);
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const { result } = renderHook(() => useReaderHistory(456));

    act(() => result.current.goBack());

    expect(backSpy).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/gallery/456');
  });

  it('uses the query detail route in a static native build', () => {
    window.history.replaceState(null, '', '/reader?id=789');
    window.__hipagoCanGoBack = vi.fn(() => false);
    const { result } = renderHook(() => useReaderHistory(789));

    act(() => result.current.goBack());

    expect(window.location.pathname).toBe('/gallery');
    expect(window.location.search).toBe('?id=789');
  });
});
