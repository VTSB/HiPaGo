// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GalleryImage } from '@/lib/utils/types';
import { ImageType } from '@/lib/utils/types';

const mocks = vi.hoisted(() => ({
  offlineResult: undefined as unknown,
  readerResult: undefined as unknown,
  preferredDualPage: false,
  supportsDualPage: true,
  fullscreen: false,
  useOfflineImages: vi.fn(),
  useReader: vi.fn(),
  setPreferredDualPage: vi.fn(),
  isReaderFullscreen: vi.fn(),
  toggleReaderFullscreen: vi.fn(),
  exitReaderFullscreen: vi.fn(),
}));

vi.mock('@/features/reader/hooks/useOfflineImages', () => ({
  useOfflineImages: (galleryId: number) => mocks.useOfflineImages(galleryId),
}));

vi.mock('@/features/reader/hooks/useReader', () => ({
  useReader: (galleryId: number, initialPage?: number, localImages?: GalleryImage[] | null) =>
    mocks.useReader(galleryId, initialPage, localImages),
}));

vi.mock('@/features/reader/hooks/useReaderZoom', () => ({
  useReaderZoom: vi.fn(),
}));

vi.mock('@/features/reader/hooks/useSupportsDualPage', () => ({
  useSupportsDualPage: () => mocks.supportsDualPage,
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (
    selector: (state: {
      dualPage: boolean;
      setDualPage: (enabled: boolean) => void;
      locale: 'en';
    }) => unknown,
  ) =>
    selector({
      dualPage: mocks.preferredDualPage,
      setDualPage: mocks.setPreferredDualPage,
      locale: 'en',
    }),
}));

vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) =>
    ({
      'reader.back': 'Back',
      'reader.empty': 'No pages',
      'reader.loadFailed': 'Could not prepare the reader',
      'reader.retry': 'Retry',
    })[key] ?? key,
}));

vi.mock('@/shared/hooks/useScrollReveal', () => ({
  useScrollReveal: vi.fn(),
}));

vi.mock('@/lib/utils/reader-fullscreen', () => ({
  isReaderFullscreen: () => mocks.isReaderFullscreen(),
  toggleReaderFullscreen: (target?: Element | null) => mocks.toggleReaderFullscreen(target),
  exitReaderFullscreen: () => mocks.exitReaderFullscreen(),
}));

vi.mock('../components/PageReader', () => ({
  PageReader: ({ dualPage }: { dualPage?: boolean }) => (
    <div data-testid="page-reader" data-dual-page={String(Boolean(dualPage))} />
  ),
}));

vi.mock('../components/ScrollReader', () => ({
  ScrollReader: () => <div data-testid="scroll-reader" />,
}));

vi.mock('../components/ReaderControls', () => ({
  ReaderControls: ({
    onBack,
    onNextPage,
    onPrevPage,
    onToggleFullscreen,
    fullscreen,
  }: {
    onBack: () => void;
    onNextPage: () => void;
    onPrevPage: () => void;
    onToggleFullscreen: () => void;
    fullscreen: boolean;
  }) => (
    <div data-testid="reader-controls" data-fullscreen={String(fullscreen)}>
      <button type="button" onClick={onBack}>
        Controls back
      </button>
      <button type="button" onClick={onPrevPage}>
        Controls previous
      </button>
      <button type="button" onClick={onNextPage}>
        Controls next
      </button>
      <button type="button" onClick={onToggleFullscreen}>
        Controls fullscreen
      </button>
      <input aria-label="Page editor" type="number" />
    </div>
  ),
}));

import { ReaderView } from '../components/ReaderView';

function makeImages(count: number): GalleryImage[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `${index + 1}.webp`,
    hash: `hash-${index + 1}`,
    width: 800,
    height: 1200,
    types: new Set([ImageType.WEBP]),
  }));
}

function makeOfflineResult(
  overrides: Partial<{
    sources: null;
    urls: null;
    dims: null;
    missing: boolean;
    error: Error | null;
    retry: ReturnType<typeof vi.fn>;
    loading: boolean;
  }> = {},
) {
  return {
    sources: null,
    urls: null,
    dims: null,
    missing: true,
    error: null,
    retry: vi.fn(),
    loading: false,
    ...overrides,
  };
}

function makeReaderResult(
  overrides: Partial<{
    currentPage: number;
    totalPages: number;
    mode: 'page' | 'scroll';
    images: GalleryImage[];
    isLoading: boolean;
    error: string | null;
  }> = {},
) {
  const images = overrides.images ?? makeImages(overrides.totalPages ?? 5);
  return {
    galleryId: 91,
    currentPage: 0,
    totalPages: images.length,
    mode: 'page' as const,
    images,
    isLoading: false,
    error: null,
    retry: vi.fn(),
    setCurrentPage: vi.fn(),
    setMode: vi.fn(),
    setScrollPosition: vi.fn(),
    goBack: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.preferredDualPage = false;
  mocks.supportsDualPage = true;
  mocks.fullscreen = false;
  mocks.offlineResult = makeOfflineResult();
  mocks.readerResult = makeReaderResult();
  mocks.useOfflineImages.mockImplementation(() => mocks.offlineResult);
  mocks.useReader.mockImplementation(() => mocks.readerResult);
  mocks.isReaderFullscreen.mockImplementation(async () => mocks.fullscreen);
  mocks.toggleReaderFullscreen.mockImplementation(async () => {
    mocks.fullscreen = !mocks.fullscreen;
    return mocks.fullscreen;
  });
  mocks.exitReaderFullscreen.mockImplementation(async () => {
    mocks.fullscreen = false;
    return false;
  });
});

describe('ReaderView integration wiring', () => {
  it('keeps an on-screen back action available while the reader is loading', async () => {
    const reader = makeReaderResult({ images: [], totalPages: 0, isLoading: true });
    mocks.readerResult = reader;
    mocks.offlineResult = makeOfflineResult({ loading: true, missing: false });

    render(<ReaderView galleryId={91} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    await waitFor(() => expect(reader.goBack).toHaveBeenCalledOnce());
  });

  it('keeps an unreadable offline gallery local and retries the offline lookup', () => {
    const offlineRetry = vi.fn();
    const readerRetry = vi.fn();
    mocks.offlineResult = makeOfflineResult({
      missing: false,
      error: new Error('SAF permission was revoked'),
      retry: offlineRetry,
    });
    mocks.readerResult = makeReaderResult({ images: [], totalPages: 0 });
    (mocks.readerResult as ReturnType<typeof makeReaderResult>).retry = readerRetry;

    render(<ReaderView galleryId={91} />);

    expect(screen.getByRole('alert')).toHaveTextContent('SAF permission was revoked');
    expect(mocks.useReader).toHaveBeenCalledWith(91, undefined, null);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(offlineRetry).toHaveBeenCalledOnce();
    expect(readerRetry).not.toHaveBeenCalled();
  });

  it('falls back to the network for a missing download and retries the gallery query', () => {
    const networkRetry = vi.fn();
    mocks.offlineResult = makeOfflineResult({ missing: true });
    mocks.readerResult = makeReaderResult({ images: [], totalPages: 0, error: 'Network failed' });
    (mocks.readerResult as ReturnType<typeof makeReaderResult>).retry = networkRetry;

    render(<ReaderView galleryId={91} initialPage={3} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Network failed');
    expect(mocks.useReader).toHaveBeenCalledWith(91, 3, undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(networkRetry).toHaveBeenCalledOnce();
    expect(
      (mocks.offlineResult as ReturnType<typeof makeOfflineResult>).retry,
    ).not.toHaveBeenCalled();
  });

  it('moves by spreads and clamps previous/next navigation at dual-page boundaries', () => {
    mocks.preferredDualPage = true;
    const reader = makeReaderResult({ currentPage: 1, totalPages: 5 });
    mocks.readerResult = reader;
    const view = render(<ReaderView galleryId={91} />);

    expect(screen.getByTestId('page-reader')).toHaveAttribute('data-dual-page', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Controls previous' }));
    fireEvent.click(screen.getByRole('button', { name: 'Controls next' }));
    expect(reader.setCurrentPage).toHaveBeenNthCalledWith(1, 0);
    expect(reader.setCurrentPage).toHaveBeenNthCalledWith(2, 2);

    reader.currentPage = 4;
    view.rerender(<ReaderView galleryId={91} />);
    reader.setCurrentPage.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Controls next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Controls previous' }));
    expect(reader.setCurrentPage).toHaveBeenNthCalledWith(1, 4);
    expect(reader.setCurrentPage).toHaveBeenNthCalledWith(2, 2);
  });

  it('does not hijack navigation keys from the focused page editor', () => {
    const reader = makeReaderResult({ currentPage: 0, totalPages: 5 });
    mocks.readerResult = reader;
    render(<ReaderView galleryId={91} />);

    fireEvent.keyDown(screen.getByRole('spinbutton', { name: 'Page editor' }), {
      key: 'ArrowRight',
    });
    expect(reader.setCurrentPage).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(reader.setCurrentPage).toHaveBeenCalledOnce();
    expect(reader.setCurrentPage).toHaveBeenCalledWith(1);
  });

  it('exits fullscreen before navigating back', async () => {
    const reader = makeReaderResult();
    mocks.readerResult = reader;
    mocks.fullscreen = true;
    render(<ReaderView galleryId={91} />);

    await waitFor(() =>
      expect(screen.getByTestId('reader-controls')).toHaveAttribute('data-fullscreen', 'true'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Controls back' }));
    await waitFor(() => expect(mocks.exitReaderFullscreen).toHaveBeenCalledOnce());
    expect(reader.goBack).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Controls back' }));
    });
    await waitFor(() => expect(reader.goBack).toHaveBeenCalledOnce());
  });
});
