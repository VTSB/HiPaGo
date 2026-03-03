'use client';

import { useEffect, useCallback, useRef } from 'react';
import { useReaderStore } from '@/features/reader/store/reader.store';

/**
 * Manages browser history entries for page-mode reader navigation.
 * Pushes state on page changes so mouse-back works, and provides goBack()
 * to unwind all reader entries at once.
 */
export function useReaderHistory(galleryId: number) {
  const storeGalleryId = useReaderStore((s) => s.galleryId);
  const currentPage = useReaderStore((s) => s.currentPage);
  const mode = useReaderStore((s) => s.mode);
  const setCurrentPage = useReaderStore((s) => s.setCurrentPage);

  const isPopstateRef = useRef(false);
  const initializedRef = useRef(false);
  const pushCountRef = useRef(0);

  // Reset history tracking when gallery changes
  useEffect(() => {
    initializedRef.current = false;
    pushCountRef.current = 0;
  }, [storeGalleryId]);

  // Push page changes to browser history (page mode only)
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

  // Listen for popstate (browser back button)
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
    if (count > 0) {
      window.history.go(-(count + 1));
    } else {
      window.location.href = `/gallery/${galleryId}`;
    }
  }, [galleryId]);

  return { goBack };
}
