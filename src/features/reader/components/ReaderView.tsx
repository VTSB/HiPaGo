'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useReader } from '@/features/reader/hooks/useReader';
import { PageReader } from './PageReader';
import { ScrollReader } from './ScrollReader';
import { ReaderControls } from './ReaderControls';
import { Spinner } from '@/shared/components/Spinner';
import { useSettingsStore } from '@/lib/store/settings';

export function ReaderView({ galleryId, initialPage }: { galleryId: number; initialPage?: number }) {
  const reader = useReader(galleryId, initialPage);
  const scrollNodeRef = useRef<HTMLDivElement | null>(null);
  const scrollCallbackRef = useCallback((node: HTMLDivElement | null) => {
    scrollNodeRef.current = node;
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
    const offset = targetEl.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
    node.scrollTo({ top: offset, behavior: 'smooth' });
    scrollTimerRef.current = setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 600);
  }, []);

  const dualPage = useSettingsStore((s) => s.dualPage);

  const handleNextPage = useCallback(() => {
    const step = dualPage && reader.mode === 'page' ? 2 : 1;
    const nextIdx = Math.min(reader.currentPage + step, reader.totalPages - 1);
    reader.setCurrentPage(nextIdx);
    if (reader.mode === 'scroll') scrollToPageElement(nextIdx);
  }, [reader.currentPage, reader.totalPages, reader.mode, reader.setCurrentPage, scrollToPageElement, dualPage]);

  const handlePrevPage = useCallback(() => {
    const step = dualPage && reader.mode === 'page' ? 2 : 1;
    const prevIdx = Math.max(reader.currentPage - step, 0);
    reader.setCurrentPage(prevIdx);
    if (reader.mode === 'scroll') scrollToPageElement(prevIdx);
  }, [reader.currentPage, reader.mode, reader.setCurrentPage, scrollToPageElement, dualPage]);

  const handleVisiblePageChange = useCallback((page: number) => {
    if (programmaticScrollRef.current) return;
    reader.setCurrentPage(page);
  }, [reader.setCurrentPage]);

  const handlePageChange = useCallback((page: number) => {
    reader.setCurrentPage(page);
    if (reader.mode === 'scroll') scrollToPageElement(page);
  }, [reader.setCurrentPage, reader.mode, scrollToPageElement]);

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

  if (reader.isLoading) return <div className="flex min-h-screen items-center justify-center bg-black"><Spinner size="md" className="border-zinc-600 border-t-white" /></div>;
  if (reader.error) return <div className="flex min-h-screen items-center justify-center bg-black text-red-400">{reader.error}</div>;

  return (
    <div className="relative min-h-screen bg-black">
      <button
        onClick={reader.goBack}
        className="fixed left-4 top-4 z-50 rounded-full bg-black/60 p-2.5 text-zinc-400 shadow-2xl backdrop-blur-md transition-colors hover:bg-black/80 hover:text-white active:bg-black/80"
        aria-label="Back"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5"><path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd" /></svg>
      </button>
      {reader.mode === 'page'
        ? <PageReader images={reader.images} currentPage={reader.currentPage} onPageChange={reader.setCurrentPage} />
        : <ScrollReader images={reader.images} initialPage={reader.currentPage} onScrollPositionChange={reader.setScrollPosition} onVisiblePageChange={handleVisiblePageChange} scrollCallbackRef={scrollCallbackRef} scrollNodeRef={scrollNodeRef} />}
      <ReaderControls onBack={reader.goBack} currentPage={reader.currentPage} totalPages={reader.totalPages} mode={reader.mode} onModeChange={reader.setMode} onNextPage={handleNextPage} onPrevPage={handlePrevPage} onPageChange={handlePageChange} />
    </div>
  );
}
