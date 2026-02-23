'use client';

import { useEffect, useCallback, useRef } from 'react';
import { useReaderStore } from '@/features/reader/store/reader.store';
import { useGalleryDetail } from '@/features/gallery-detail/hooks/useGalleryDetail';
import { recordHistory, getReadingProgress } from '@/lib/db/gallery';

export function useReader(galleryId: number, initialPage?: number) {
  const setGallery = useReaderStore((s) => s.setGallery);
  const setCurrentPage = useReaderStore((s) => s.setCurrentPage);
  const setMode = useReaderStore((s) => s.setMode);
  const nextPage = useReaderStore((s) => s.nextPage);
  const prevPage = useReaderStore((s) => s.prevPage);
  const setScrollPosition = useReaderStore((s) => s.setScrollPosition);
  const storeGalleryId = useReaderStore((s) => s.galleryId);
  const currentPage = useReaderStore((s) => s.currentPage);
  const totalPages = useReaderStore((s) => s.totalPages);
  const mode = useReaderStore((s) => s.mode);
  const images = useReaderStore((s) => s.images);
  const isLoading = useReaderStore((s) => s.isLoading);
  const error = useReaderStore((s) => s.error);

  const { images: galleryImages, isLoading: galleryLoading, error: galleryError } = useGalleryDetail(galleryId);

  useEffect(() => {
    if (galleryImages && galleryImages.images.length > 0) {
      setGallery(galleryId, galleryImages.images);
      if (initialPage && initialPage > 0) {
        // initialPage is 1-based (from URL), store is 0-based
        setCurrentPage(Math.min(initialPage - 1, galleryImages.images.length - 1));
      } else {
        getReadingProgress(galleryId).then((p) => {
          if (p) {
            setCurrentPage(p.lastPage);
            setMode(p.readerMode as 'page' | 'scroll');
          }
        });
      }
    }
  }, [galleryImages, galleryId, initialPage, setGallery, setCurrentPage, setMode]);

  // Push page changes to browser history (page mode only) so mouse-back works
  const isPopstateRef = useRef(false);
  const initializedRef = useRef(false);
  const pushCountRef = useRef(0);

  useEffect(() => {
    if (!storeGalleryId || mode !== 'page') return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      const url = new URL(window.location.href);
      url.searchParams.set('page', String(currentPage + 1));
      window.history.replaceState({ readerPage: currentPage }, '', url.toString());
      return;
    }
    if (isPopstateRef.current) {
      isPopstateRef.current = false;
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set('page', String(currentPage + 1));
    window.history.pushState({ readerPage: currentPage }, '', url.toString());
    pushCountRef.current += 1;
  }, [currentPage, storeGalleryId, mode]);

  useEffect(() => {
    function onPopState(e: PopStateEvent) {
      if (e.state && typeof e.state.readerPage === 'number') {
        isPopstateRef.current = true;
        pushCountRef.current = Math.max(0, pushCountRef.current - 1);
        setCurrentPage(e.state.readerPage);
      }
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [setCurrentPage]);

  // Navigate back, unwinding all reader history entries
  const goBack = useCallback(() => {
    const count = pushCountRef.current;
    pushCountRef.current = 0;
    initializedRef.current = false;
    // +1 to also skip past the initial replaceState entry (the reader page itself)
    window.history.go(-(count + 1));
  }, []);

  // Debounced save — only persist after 2s of no page changes
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latestState = useRef({ currentPage, totalPages, mode, storeGalleryId });
  latestState.current = { currentPage, totalPages, mode, storeGalleryId };

  useEffect(() => {
    if (!storeGalleryId) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const { storeGalleryId: id, currentPage: p, totalPages: t, mode: m } = latestState.current;
      if (id) recordHistory(id, p, t, m);
    }, 2000);
    return () => clearTimeout(saveTimer.current);
  }, [currentPage, storeGalleryId]);

  // Save on unmount (leaving reader)
  useEffect(() => {
    return () => {
      clearTimeout(saveTimer.current);
      const { storeGalleryId: id, currentPage: p, totalPages: t, mode: m } = latestState.current;
      if (id) recordHistory(id, p, t, m);
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (mode !== 'page') return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        nextPage();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        prevPage();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mode, nextPage, prevPage]);

  return {
    galleryId: storeGalleryId,
    currentPage,
    totalPages,
    mode,
    images,
    isLoading: galleryLoading || isLoading,
    error: galleryError?.message || error,
    setGallery,
    setCurrentPage,
    setMode,
    nextPage,
    prevPage,
    setScrollPosition,
    goBack,
  };
}
