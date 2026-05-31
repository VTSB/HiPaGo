'use client';

import { useEffect, useRef } from 'react';
import { useReaderStore } from '@/features/reader/store/reader.store';
import { useGalleryDetail } from '@/features/gallery-detail/hooks/useGalleryDetail';
import { getReadingProgress } from '@/lib/db/gallery';
import { useSettingsStore } from '@/lib/store/settings';
import { useReaderHistory } from './useReaderHistory';
import { useReaderPersistence } from './useReaderPersistence';

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

  const userNavigatedRef = useRef(false);

  useEffect(() => {
    if (galleryImages && galleryImages.images.length > 0) {
      setGallery(galleryId, galleryImages.images);
      // Apply user's preferred reader mode from settings as immediate default
      const preferredMode = useSettingsStore.getState().readerMode;
      setMode(preferredMode);
      userNavigatedRef.current = false;
      if (initialPage && initialPage > 0) {
        setCurrentPage(Math.min(initialPage - 1, galleryImages.images.length - 1));
      } else {
        const capturedId = galleryId;
        getReadingProgress(galleryId)
          .then((p) => {
            // History overrides settings when available
            if (p && useReaderStore.getState().galleryId === capturedId && !userNavigatedRef.current) {
              setCurrentPage(p.lastPage);
              setMode(p.readerMode as 'page' | 'scroll');
            }
          })
          .catch(() => {
            // Recoverable: DB unavailable — reader opens at the default
            // page/mode. A dead DB must not break opening the reader.
          });
      }
    }
  }, [galleryImages, galleryId, initialPage, setGallery, setCurrentPage, setMode]);

  const { goBack } = useReaderHistory();
  useReaderPersistence();

  // Keyboard navigation is handled in ReaderView to support both page and scroll modes

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
