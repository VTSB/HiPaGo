'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useReaderStore } from '@/features/reader/store/reader.store';
import { useGalleryDetail } from '@/features/gallery-detail/hooks/useGalleryDetail';
import { getReadingProgress } from '@/lib/db/gallery';
import { useSettingsStore } from '@/lib/store/settings';
import { useReaderHistory } from './useReaderHistory';
import { useReaderPersistence } from './useReaderPersistence';
import type { GalleryImage } from '@/lib/utils/types';

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

  const {
    images: galleryImages,
    isLoading: galleryLoading,
    error: galleryError,
  } = useGalleryDetail(galleryId);

  const initializedId = useRef<number | null>(null);
  const initialization = useRef(0);

  // Both detail images and manifest-only offline pages use the same initializer.
  // A later metadata result must not reset a reader already opened from files.
  const initializeGallery = useCallback(
    (id: number, nextImages: GalleryImage[]) => {
      if (nextImages.length === 0) return;
      const previous = useReaderStore.getState();
      const alreadyOpened = initializedId.current === id && previous.galleryId === id;
      const generation = alreadyOpened ? initialization.current : ++initialization.current;
      initializedId.current = id;
      const clamp = (page: number) => Math.max(0, Math.min(page, nextImages.length - 1));
      setGallery(id, nextImages);
      if (alreadyOpened) {
        setCurrentPage(clamp(previous.currentPage));
        setMode(previous.mode);
        return;
      }
      const preferredMode = useSettingsStore.getState().readerMode;
      setMode(preferredMode);
      if (initialPage && Number.isFinite(initialPage) && initialPage > 0) {
        setCurrentPage(clamp(Math.floor(initialPage) - 1));
        return;
      }
      let navigated = false;
      const unsubscribe = useReaderStore.subscribe((next, previousState) => {
        if (next.currentPage !== previousState.currentPage || next.mode !== previousState.mode)
          navigated = true;
      });
      getReadingProgress(id)
        .then((progress) => {
          const current = useReaderStore.getState();
          if (
            progress &&
            Number.isFinite(progress.totalPages) &&
            progress.totalPages > 0 &&
            Number.isFinite(progress.lastPage) &&
            !navigated &&
            initialization.current === generation &&
            current.galleryId === id
          ) {
            setCurrentPage(
              Math.max(0, Math.min(Math.floor(progress.lastPage), current.totalPages - 1)),
            );
            if (progress.readerMode === 'page' || progress.readerMode === 'scroll')
              setMode(progress.readerMode);
          }
        })
        .catch(() => {
          // DB unavailable: default page/mode still opens the reader.
        })
        .finally(unsubscribe);
    },
    [initialPage, setGallery, setCurrentPage, setMode],
  );

  useEffect(() => {
    if (galleryImages && galleryImages.images.length > 0)
      initializeGallery(galleryId, galleryImages.images);
  }, [galleryImages, galleryId, initializeGallery]);

  useEffect(
    () => () => {
      initialization.current += 1;
      initializedId.current = null;
    },
    [],
  );

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
    setGallery: initializeGallery,
    setCurrentPage,
    setMode,
    nextPage,
    prevPage,
    setScrollPosition,
    goBack,
  };
}
