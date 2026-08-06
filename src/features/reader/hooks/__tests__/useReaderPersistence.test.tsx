// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordHistory } from '@/lib/db/gallery';
import { useReaderStore } from '@/features/reader/store/reader.store';
import { __resetReaderHistoryLanesForTests, useReaderPersistence } from '../useReaderPersistence';

vi.mock('@/lib/db/gallery', () => ({
  recordHistory: vi.fn(() => Promise.resolve()),
}));

const initialReaderState = {
  galleryId: 42,
  currentPage: 2,
  totalPages: 10,
  mode: 'page' as const,
  progressReadyGalleryId: 42,
};

describe('useReaderPersistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetReaderHistoryLanesForTests();
    vi.mocked(recordHistory).mockReset().mockResolvedValue(undefined);
    useReaderStore.setState(initialReaderState);
  });

  afterEach(async () => {
    cleanup();
    await act(async () => Promise.resolve());
    __resetReaderHistoryLanesForTests();
    act(() => {
      useReaderStore.setState({
        galleryId: null,
        currentPage: 0,
        totalPages: 0,
        mode: 'page',
        progressReadyGalleryId: null,
      });
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('debounces mode and total-page changes for two seconds', async () => {
    renderHook(() => useReaderPersistence());

    act(() => vi.advanceTimersByTime(1000));
    act(() => useReaderStore.setState({ mode: 'scroll' }));
    act(() => vi.advanceTimersByTime(1999));
    expect(recordHistory).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(recordHistory).toHaveBeenLastCalledWith(42, 2, 10, 'scroll');

    vi.mocked(recordHistory).mockClear();
    act(() => useReaderStore.setState({ totalPages: 12 }));
    act(() => vi.advanceTimersByTime(1999));
    expect(recordHistory).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(recordHistory).toHaveBeenLastCalledWith(42, 2, 12, 'scroll');
  });

  it('immediately saves the latest progress when the document becomes hidden', () => {
    renderHook(() => useReaderPersistence());
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    act(() => useReaderStore.setState({ currentPage: 7, totalPages: 15, mode: 'scroll' }));
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    expect(recordHistory).toHaveBeenCalledTimes(1);
    expect(recordHistory).toHaveBeenCalledWith(42, 7, 15, 'scroll');

    act(() => vi.advanceTimersByTime(2000));
    expect(recordHistory).toHaveBeenCalledTimes(1);
  });

  it('reads the latest store snapshot when pagehide fires before passive effects', () => {
    renderHook(() => useReaderPersistence());

    act(() => {
      useReaderStore.setState({ currentPage: 8, totalPages: 16, mode: 'scroll' });
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(recordHistory).toHaveBeenCalledTimes(1);
    expect(recordHistory).toHaveBeenCalledWith(42, 8, 16, 'scroll');
  });

  it('flushes the previous gallery before debouncing a replacement gallery', async () => {
    renderHook(() => useReaderPersistence());

    act(() => vi.advanceTimersByTime(1000));
    act(() => {
      useReaderStore.setState({
        galleryId: 84,
        currentPage: 1,
        totalPages: 6,
        mode: 'scroll',
        progressReadyGalleryId: 84,
      });
    });

    expect(recordHistory).toHaveBeenCalledTimes(1);
    expect(recordHistory).toHaveBeenLastCalledWith(42, 2, 10, 'page');

    act(() => vi.advanceTimersByTime(1999));
    expect(recordHistory).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(recordHistory).toHaveBeenCalledTimes(2);
    expect(recordHistory).toHaveBeenLastCalledWith(84, 1, 6, 'scroll');
  });

  it('does not flush an incomplete previous gallery during a gallery switch', () => {
    useReaderStore.setState({ totalPages: 0 });
    renderHook(() => useReaderPersistence());

    act(() => {
      useReaderStore.setState({
        galleryId: 84,
        currentPage: 1,
        totalPages: 6,
        progressReadyGalleryId: 84,
      });
    });

    expect(recordHistory).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(2000));
    expect(recordHistory).toHaveBeenCalledTimes(1);
    expect(recordHistory).toHaveBeenCalledWith(84, 1, 6, 'page');
  });

  it('allows a failed lifecycle save to be retried', async () => {
    vi.mocked(recordHistory)
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue(undefined);
    renderHook(() => useReaderPersistence());

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await Promise.resolve();
    });
    expect(recordHistory).toHaveBeenCalledTimes(1);

    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(recordHistory).toHaveBeenCalledTimes(2);
    expect(recordHistory).toHaveBeenLastCalledWith(42, 2, 10, 'page');
  });

  it('keeps an in-flight duplicate as a retry when the active write fails', async () => {
    let rejectFirstWrite!: (reason: Error) => void;
    const firstWrite = new Promise<void>((_resolve, reject) => {
      rejectFirstWrite = reject;
    });
    vi.mocked(recordHistory).mockReturnValueOnce(firstWrite).mockResolvedValue(undefined);
    renderHook(() => useReaderPersistence());

    act(() => window.dispatchEvent(new Event('pagehide')));
    act(() => window.dispatchEvent(new Event('pagehide')));

    // The duplicate intent waits behind the active write instead of starting
    // concurrently or being discarded before its outcome is known.
    expect(recordHistory).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectFirstWrite(new Error('database unavailable'));
      await firstWrite.catch(() => undefined);
      await Promise.resolve();
    });

    expect(recordHistory).toHaveBeenCalledTimes(2);
    expect(recordHistory).toHaveBeenLastCalledWith(42, 2, 10, 'page');
  });

  it('serializes writes and coalesces queued progress to the latest snapshot', async () => {
    let finishFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      finishFirstWrite = resolve;
    });
    vi.mocked(recordHistory).mockReturnValueOnce(firstWrite).mockResolvedValue(undefined);
    renderHook(() => useReaderPersistence());

    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(recordHistory).toHaveBeenCalledTimes(1);
    expect(recordHistory).toHaveBeenLastCalledWith(42, 2, 10, 'page');

    act(() => {
      useReaderStore.setState({ currentPage: 4 });
      window.dispatchEvent(new Event('pagehide'));
      useReaderStore.setState({ currentPage: 7, mode: 'scroll' });
      window.dispatchEvent(new Event('pagehide'));
    });

    // The native/database write is still in flight; page 4 is replaced in the
    // queue by page 7 instead of starting an unordered concurrent invocation.
    expect(recordHistory).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishFirstWrite();
      await firstWrite;
      await Promise.resolve();
    });

    expect(recordHistory).toHaveBeenCalledTimes(2);
    expect(recordHistory).toHaveBeenLastCalledWith(42, 7, 10, 'scroll');
    expect(recordHistory).not.toHaveBeenCalledWith(42, 4, 10, 'page');
  });

  it('preserves the latest progress when the reader unmounts', async () => {
    const { unmount } = renderHook(() => useReaderPersistence());

    act(() => useReaderStore.setState({ currentPage: 9, totalPages: 20, mode: 'scroll' }));
    unmount();
    await act(async () => Promise.resolve());

    expect(recordHistory).toHaveBeenCalledTimes(1);
    expect(recordHistory).toHaveBeenCalledWith(42, 9, 20, 'scroll');
  });

  it('does not persist during a StrictMode effect replay', async () => {
    const { unmount } = renderHook(() => useReaderPersistence(), { reactStrictMode: true });

    await act(async () => Promise.resolve());
    expect(recordHistory).not.toHaveBeenCalled();

    unmount();
    await act(async () => Promise.resolve());
    expect(recordHistory).toHaveBeenCalledTimes(1);
    expect(recordHistory).toHaveBeenCalledWith(42, 2, 10, 'page');
  });

  it('does not persist a gallery before its page list is available', () => {
    useReaderStore.setState({ galleryId: 42, currentPage: 0, totalPages: 0, mode: 'page' });

    const { unmount } = renderHook(() => useReaderPersistence());
    act(() => vi.advanceTimersByTime(2000));
    unmount();

    expect(recordHistory).not.toHaveBeenCalled();
  });
});
