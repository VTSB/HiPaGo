'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOfflineImages } from '@/features/reader/hooks/useOfflineImages';
import { useReader } from '@/features/reader/hooks/useReader';
import { useReaderKeyboard } from '@/features/reader/hooks/useReaderKeyboard';
import { useReaderZoom } from '@/features/reader/hooks/useReaderZoom';
import { useSupportsDualPage } from '@/features/reader/hooks/useSupportsDualPage';
import { useT } from '@/lib/i18n/useT';
import { useSettingsStore } from '@/lib/store/settings';
import {
  exitReaderFullscreen,
  isReaderFullscreen,
  toggleReaderFullscreen,
} from '@/lib/utils/reader-fullscreen';
import type { GalleryImage } from '@/lib/utils/types';
import { ImageType } from '@/lib/utils/types';
import { useScrollReveal } from '@/shared/hooks/useScrollReveal';
import { PageReader } from './PageReader';
import { ReaderControls } from './ReaderControls';
import { ReaderLoadState } from './ReaderLoadState';
import { ScrollReader } from './ScrollReader';

export function ReaderView({
  galleryId,
  initialPage,
}: {
  galleryId: number;
  initialPage?: number;
}) {
  const offline = useOfflineImages(galleryId);
  const offlineCount = offline.sources?.length ?? 0;
  const offlineImages = useMemo<GalleryImage[] | null>(
    () =>
      offlineCount > 0
        ? Array.from({ length: offlineCount }, (_, index) => ({
            name: '',
            hash: `offline-${index}`,
            width: offline.dims?.[index]?.width ?? 800,
            height: offline.dims?.[index]?.height ?? 1200,
            types: new Set<ImageType>(),
          }))
        : null,
    [offlineCount, offline.dims],
  );

  // Keep the detail query paused during the cheap local lookup. A confirmed
  // missing download may use the network; an unreadable store stays local and
  // exposes an explicit retry instead of being mistaken for missing files.
  const localImages = offline.loading
    ? null
    : (offlineImages ?? (offline.error && !offline.missing ? null : undefined));
  const reader = useReader(galleryId, initialPage, localImages);
  const images = offlineImages ?? reader.images;
  const offlineSources = offline.sources ?? undefined;
  const t = useT();

  useReaderZoom();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const pageChromeHiddenRef = useRef(false);
  const backActionRef = useRef(false);
  const fullscreenActionRef = useRef(false);
  const fullscreenOwnedRef = useRef(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const scrollCallbackRef = useCallback((node: HTMLDivElement | null) => {
    setScrollElement(node);
  }, []);

  const preferredDualPage = useSettingsStore((state) => state.dualPage);
  const setPreferredDualPage = useSettingsStore((state) => state.setDualPage);
  const supportsDualPage = useSupportsDualPage();

  const { currentPage, totalPages, mode, setCurrentPage, setMode, goBack } = reader;
  const dualPage = mode === 'page' && preferredDualPage && supportsDualPage;
  const lastPage = Math.max(0, totalPages - 1);
  const lastSpreadStart = dualPage ? Math.floor(lastPage / 2) * 2 : lastPage;

  useScrollReveal({
    scrollElement,
    targetRef: rootRef,
    disabled: mode !== 'scroll',
  });

  useEffect(() => {
    let active = true;
    void isReaderFullscreen().then((next) => {
      if (active) setFullscreen(next);
    });

    const syncBrowserFullscreen = () => {
      void isReaderFullscreen().then((next) => {
        if (active) setFullscreen(next);
      });
    };
    document.addEventListener('fullscreenchange', syncBrowserFullscreen);

    return () => {
      active = false;
      document.removeEventListener('fullscreenchange', syncBrowserFullscreen);
      if (fullscreenOwnedRef.current) void exitReaderFullscreen();
    };
  }, []);

  const handleToggleFullscreen = useCallback(async () => {
    if (fullscreenActionRef.current) return;
    fullscreenActionRef.current = true;
    try {
      const wasFullscreen = await isReaderFullscreen();
      const next = await toggleReaderFullscreen(rootRef.current);
      if (!wasFullscreen && next) fullscreenOwnedRef.current = true;
      if (!next) fullscreenOwnedRef.current = false;
      setFullscreen(next);
    } finally {
      fullscreenActionRef.current = false;
    }
  }, []);

  const handleBack = useCallback(async () => {
    if (backActionRef.current) return;
    backActionRef.current = true;
    let navigationStarted = false;
    try {
      if (await isReaderFullscreen()) {
        const remainingFullscreen = await exitReaderFullscreen();
        if (!remainingFullscreen) fullscreenOwnedRef.current = false;
        setFullscreen(remainingFullscreen);
        return;
      }
      goBack();
      navigationStarted = true;
    } finally {
      // A route change unmounts the reader. Keep the guard armed until then so
      // a double click or a repeated hardware event cannot consume two entries.
      if (!navigationStarted) backActionRef.current = false;
    }
  }, [goBack]);

  const handleNextPage = useCallback(() => {
    if (totalPages <= 0) return;
    const spreadStart = dualPage ? Math.floor(currentPage / 2) * 2 : currentPage;
    setCurrentPage(Math.min(spreadStart + (dualPage ? 2 : 1), lastSpreadStart));
  }, [currentPage, dualPage, lastSpreadStart, setCurrentPage, totalPages]);

  const handlePrevPage = useCallback(() => {
    if (totalPages <= 0) return;
    const spreadStart = dualPage ? Math.floor(currentPage / 2) * 2 : currentPage;
    setCurrentPage(Math.max(spreadStart - (dualPage ? 2 : 1), 0));
  }, [currentPage, dualPage, setCurrentPage, totalPages]);

  const handleVisiblePageChange = useCallback(
    (page: number) => {
      setCurrentPage(page);
    },
    [setCurrentPage],
  );

  const handlePageChange = useCallback(
    (page: number) => {
      if (totalPages <= 0) return;
      const clamped = Math.min(Math.max(Math.trunc(page), 0), totalPages - 1);
      setCurrentPage(dualPage ? Math.floor(clamped / 2) * 2 : clamped);
    },
    [dualPage, setCurrentPage, totalPages],
  );

  const handleModeChange = useCallback(
    (nextMode: 'page' | 'scroll') => {
      pageChromeHiddenRef.current = false;
      rootRef.current?.style.setProperty('--reader-chrome', '0');
      setMode(nextMode);
    },
    [setMode],
  );

  const handleDualPageChange = useCallback(
    (enabled: boolean) => {
      setPreferredDualPage(enabled);
      if (enabled && supportsDualPage) {
        setCurrentPage(Math.floor(currentPage / 2) * 2);
      }
    },
    [currentPage, setCurrentPage, setPreferredDualPage, supportsDualPage],
  );

  const handleToggleChrome = useCallback(() => {
    if (mode !== 'page') return;
    pageChromeHiddenRef.current = !pageChromeHiddenRef.current;
    rootRef.current?.style.setProperty('--reader-chrome', pageChromeHiddenRef.current ? '1' : '0');
  }, [mode]);

  useReaderKeyboard({
    mode,
    onNextPage: handleNextPage,
    onPrevPage: handlePrevPage,
    onFirstPage: () => handlePageChange(0),
    onLastPage: () => handlePageChange(lastSpreadStart),
    onBack: () => void handleBack(),
    onToggleFullscreen: () => void handleToggleFullscreen(),
  });

  const loadStateBack = () => void handleBack();

  if (offline.loading) return <ReaderLoadState state="loading" onBack={loadStateBack} />;
  if (offline.error && offlineCount === 0) {
    return (
      <ReaderLoadState
        state="error"
        onRetry={offline.retry}
        onBack={loadStateBack}
        detail={offline.error.message}
      />
    );
  }
  if (offlineCount === 0 && reader.isLoading) {
    return <ReaderLoadState state="loading" onBack={loadStateBack} />;
  }
  if (offlineCount === 0 && reader.error) {
    return (
      <ReaderLoadState
        state="error"
        onRetry={() => void reader.retry()}
        onBack={loadStateBack}
        detail={reader.error}
      />
    );
  }
  if (images.length === 0) return <ReaderLoadState state="empty" onBack={loadStateBack} />;

  return (
    <div ref={rootRef} className="relative min-h-dvh bg-black">
      <button
        type="button"
        onClick={() => void handleBack()}
        className="reader-back-button fixed left-[calc(1rem+env(safe-area-inset-left))] top-[calc(1rem+env(safe-area-inset-top))] z-50 hidden min-h-11 min-w-11 items-center justify-center rounded-full bg-black/75 text-zinc-200 shadow-2xl backdrop-blur-md transition-colors hover:bg-black/90 hover:text-white active:bg-black/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:flex"
        style={{
          transform: 'translateY(calc(var(--reader-chrome, 0) * -200%))',
          opacity: 'calc(1 - var(--reader-chrome, 0))',
        }}
        aria-label={t('reader.back')}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-5 w-5"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {mode === 'page' ? (
        <PageReader
          images={images}
          currentPage={currentPage}
          onPageChange={handlePageChange}
          offlineSources={offlineSources}
          dualPage={dualPage}
          onToggleChrome={handleToggleChrome}
        />
      ) : (
        <ScrollReader
          images={images}
          initialPage={currentPage}
          onScrollPositionChange={reader.setScrollPosition}
          onVisiblePageChange={handleVisiblePageChange}
          scrollCallbackRef={scrollCallbackRef}
          offlineSources={offlineSources}
        />
      )}

      <ReaderControls
        onBack={() => void handleBack()}
        currentPage={currentPage}
        totalPages={totalPages}
        mode={mode}
        onModeChange={handleModeChange}
        onNextPage={handleNextPage}
        onPrevPage={handlePrevPage}
        onPageChange={handlePageChange}
        dualPage={dualPage}
        onDualPageChange={handleDualPageChange}
        fullscreen={fullscreen}
        onToggleFullscreen={() => void handleToggleFullscreen()}
      />
    </div>
  );
}
