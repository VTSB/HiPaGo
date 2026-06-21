'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReader } from '@/features/reader/hooks/useReader';
import { useOfflineImages } from '@/features/reader/hooks/useOfflineImages';
import type { GalleryImage } from '@/lib/utils/types';
import { ImageType } from '@/lib/utils/types';
import { PageReader } from './PageReader';
import { ScrollReader } from './ScrollReader';
import { ReaderControls } from './ReaderControls';
import { Spinner } from '@/shared/components/Spinner';
import { useSettingsStore } from '@/lib/store/settings';
import { useScrollReveal } from '@/shared/hooks/useScrollReveal';
import { useReaderZoom } from '@/features/reader/hooks/useReaderZoom';

export function ReaderView({
  galleryId,
  initialPage,
}: {
  galleryId: number;
  initialPage?: number;
}) {
  const reader = useReader(galleryId, initialPage);
  const offline = useOfflineImages(galleryId);
  // Enable native WebView pinch-zoom only while the reader is open (Android);
  // other screens stay non-zoomable.
  useReaderZoom();
  // The chrome (back button + ReaderControls) reveal is driven by the
  // `--reader-chrome` CSS var set on this root node.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollNodeRef = useRef<HTMLDivElement | null>(null);
  // Mirrored as state so `useScrollReveal` can re-subscribe once the
  // ScrollReader mounts its inner overflow container.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const scrollCallbackRef = useCallback((node: HTMLDivElement | null) => {
    scrollNodeRef.current = node;
    setScrollElement(node);
  }, []);

  const programmaticScrollRef = useRef(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const scrollToPageElement = useCallback((targetIdx: number) => {
    const node = scrollNodeRef.current;
    if (!node) return;
    const targetEl = node.querySelector(`[data-page-index="${targetIdx}"]`) as HTMLElement | null;
    if (!targetEl) return;
    programmaticScrollRef.current = true;
    clearTimeout(scrollTimerRef.current);
    const offset =
      targetEl.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
    node.scrollTo({ top: offset, behavior: 'smooth' });
    scrollTimerRef.current = setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 600);
  }, []);

  const dualPage = useSettingsStore((s) => s.dualPage);

  // Destructure stable reader members so the React Compiler can preserve
  // manual memoization on the callbacks below (member expressions like
  // reader.currentPage cannot be tracked by the compiler).
  const { currentPage, totalPages, mode, setCurrentPage } = reader;

  // Gesture-couple the back button + ReaderControls to the inner reader
  // scroll (scroll mode only): scrolling down slides them off, scrolling up
  // brings them back proportionally — native style, not a binary snap. Page
  // mode keeps the chrome always visible (disabled → var stays 0). Writes the
  // `--reader-chrome` var onto rootRef; the chrome elements read it.
  useScrollReveal({
    scrollElement,
    targetRef: rootRef,
    disabled: mode !== 'scroll',
  });

  const handleNextPage = useCallback(() => {
    const step = dualPage && mode === 'page' ? 2 : 1;
    const nextIdx = Math.min(currentPage + step, totalPages - 1);
    setCurrentPage(nextIdx);
    if (mode === 'scroll') scrollToPageElement(nextIdx);
  }, [currentPage, totalPages, mode, setCurrentPage, scrollToPageElement, dualPage]);

  const handlePrevPage = useCallback(() => {
    const step = dualPage && mode === 'page' ? 2 : 1;
    const prevIdx = Math.max(currentPage - step, 0);
    setCurrentPage(prevIdx);
    if (mode === 'scroll') scrollToPageElement(prevIdx);
  }, [currentPage, mode, setCurrentPage, scrollToPageElement, dualPage]);

  const handleVisiblePageChange = useCallback(
    (page: number) => {
      if (programmaticScrollRef.current) return;
      setCurrentPage(page);
    },
    [setCurrentPage],
  );

  const handlePageChange = useCallback(
    (page: number) => {
      setCurrentPage(page);
      if (mode === 'scroll') scrollToPageElement(page);
    },
    [setCurrentPage, mode, scrollToPageElement],
  );

  // Arrow key navigation for both page and scroll modes
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        handleNextPage();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        handlePrevPage();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleNextPage, handlePrevPage]);

  // A downloaded gallery must read fully offline — its page count comes from the
  // local manifest (offline.sources), NOT the network detail query. Synthesize an
  // image list of the right length so the readers + controls work without the
  // gallery-info fetch (which can never resolve offline → the old infinite spin).
  const offlineCount = offline.sources?.length ?? 0;
  const images: GalleryImage[] = useMemo(
    () =>
      offlineCount > 0 && reader.images.length !== offlineCount
        ? Array.from({ length: offlineCount }, (_, i) => ({
            name: '',
            hash: `offline-${i}`,
            // The fast offline path avoids pre-decoding every stored page before
            // first paint; use a stable manga-page fallback if dimensions are
            // unavailable.
            width: offline.dims?.[i]?.width ?? 800,
            height: offline.dims?.[i]?.height ?? 1200,
            types: new Set<ImageType>(),
          }))
        : reader.images,
    [offlineCount, reader.images, offline.dims],
  );

  // Seed the reader store from the manifest so totalPages / navigation / the
  // page controls work offline (the network path's seeding never fires offline).
  const seedGallery = reader.setGallery;
  useEffect(() => {
    if (offlineCount > 0 && images !== reader.images) {
      seedGallery(galleryId, images);
    }
  }, [offlineCount, images, reader.images, galleryId, seedGallery]);

  // Wait on the network reader query ONLY when the gallery is not downloaded;
  // a downloaded gallery renders from local files regardless of network state.
  if (offline.loading || (offlineCount === 0 && reader.isLoading))
    return (
      <div className="flex min-h-screen items-center justify-center bg-black">
        <Spinner size="md" className="border-zinc-600 border-t-white" />
      </div>
    );
  if (offlineCount === 0 && reader.error)
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-red-400">
        {reader.error}
      </div>
    );

  // NOTE: when a downloaded gallery's stored files are missing/corrupt,
  // useOfflineImages returns sources:null (offlineCount === 0) so we DELIBERATELY
  // fall through to the normal cache→network reader path above (useReader runs
  // regardless of download status) rather than showing a dead-end "files
  // missing" screen. The detail page surfaces the missing-files state at the
  // download button instead. So there is no `offline.missing` branch here.

  // Pass offline sources when available; readers fall back to network when undefined.
  const offlineSources = offline.sources ?? undefined;

  return (
    <div ref={rootRef} className="relative min-h-screen bg-black">
      <button
        onClick={reader.goBack}
        className="fixed left-4 top-4 z-50 rounded-full bg-black/60 p-2.5 text-zinc-400 shadow-2xl backdrop-blur-md transition-[colors,background-color] duration-300 will-change-transform hover:bg-black/80 hover:text-white active:bg-black/80"
        style={{
          // Gesture-coupled with ReaderControls: slides up off the top as the
          // chrome hides (--reader-chrome 0 → 1). No transform transition so it
          // tracks the scroll without lag.
          transform: 'translateY(calc(var(--reader-chrome, 0) * -200%))',
          opacity: 'calc(1 - var(--reader-chrome, 0))',
        }}
        aria-label="Back"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-5 w-5"
        >
          <path
            fillRule="evenodd"
            d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {reader.mode === 'page' ? (
        <PageReader
          images={images}
          currentPage={reader.currentPage}
          onPageChange={reader.setCurrentPage}
          offlineSources={offlineSources}
        />
      ) : (
        <ScrollReader
          images={images}
          initialPage={reader.currentPage}
          onScrollPositionChange={reader.setScrollPosition}
          onVisiblePageChange={handleVisiblePageChange}
          scrollCallbackRef={scrollCallbackRef}
          scrollNodeRef={scrollNodeRef}
          offlineSources={offlineSources}
        />
      )}
      <ReaderControls
        onBack={reader.goBack}
        currentPage={reader.currentPage}
        totalPages={reader.totalPages}
        mode={reader.mode}
        onModeChange={reader.setMode}
        onNextPage={handleNextPage}
        onPrevPage={handlePrevPage}
        onPageChange={handlePageChange}
      />
    </div>
  );
}
