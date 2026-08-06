'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useReaderStore } from '@/features/reader/store/reader.store';
import { useGalleryDetail } from '@/features/gallery-detail/hooks/useGalleryDetail';
import { getReadingProgress } from '@/lib/db/gallery';
import { useSettingsStore } from '@/lib/store/settings';
import type { GalleryImage } from '@/lib/utils/types';
import { useReaderHistory } from './useReaderHistory';
import { useReaderPersistence, waitForPendingReaderHistoryWrites } from './useReaderPersistence';

type ReaderMode = 'page' | 'scroll';

function normalizeStoredReaderMode(mode: string): ReaderMode | null {
  if (mode === 'page' || mode === 'horizontal') return 'page';
  if (mode === 'scroll' || mode === 'vertical' || mode === 'webtoon') return 'scroll';
  return null;
}

function clampPage(page: number, totalPages: number): number {
  if (!Number.isFinite(page) || totalPages <= 0) return 0;
  return Math.min(Math.max(Math.trunc(page), 0), totalPages - 1);
}

function sameImageList(left: GalleryImage[], right: GalleryImage[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((image, index) => {
    const other = right[index];
    return (
      image.name === other.name &&
      image.hash === other.hash &&
      image.width === other.width &&
      image.height === other.height &&
      image.types.size === other.types.size &&
      [...image.types].every((type) => other.types.has(type))
    );
  });
}

export function useReader(
  galleryId: number,
  initialPage?: number,
  localImages?: GalleryImage[] | null,
) {
  const setGallery = useReaderStore((s) => s.setGallery);
  const storeSetCurrentPage = useReaderStore((s) => s.setCurrentPage);
  const storeSetMode = useReaderStore((s) => s.setMode);
  const storeNextPage = useReaderStore((s) => s.nextPage);
  const storePrevPage = useReaderStore((s) => s.prevPage);
  const markProgressReady = useReaderStore((s) => s.markProgressReady);
  const setScrollPosition = useReaderStore((s) => s.setScrollPosition);
  const storeGalleryId = useReaderStore((s) => s.galleryId);
  const currentPage = useReaderStore((s) => s.currentPage);
  const totalPages = useReaderStore((s) => s.totalPages);
  const mode = useReaderStore((s) => s.mode);
  const images = useReaderStore((s) => s.images);
  const isLoading = useReaderStore((s) => s.isLoading);
  const error = useReaderStore((s) => s.error);

  // Passing a local manifest (or null while its store is being checked) is an
  // explicit offline path. Keep hook order stable while disabling the network
  // query via useGalleryDetail's id guard.
  const useNetworkImages = localImages === undefined;
  const {
    images: galleryImages,
    isLoading: galleryLoading,
    error: galleryError,
    retry: retryGallery,
  } = useGalleryDetail(useNetworkImages ? galleryId : 0);
  const resolvedImages = useNetworkImages ? (galleryImages?.images ?? null) : localImages;

  const userNavigatedRef = useRef(false);
  const initializedGalleryRef = useRef<number | null>(null);
  const initialPageAppliedGalleryRef = useRef<number | null>(null);
  const progressResolvedGalleryRef = useRef<number | null>(null);
  const progressRequestRef = useRef<{
    galleryId: number;
    promise: ReturnType<typeof getReadingProgress>;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (resolvedImages === null) {
      const current = useReaderStore.getState();
      if (current.galleryId !== galleryId) setGallery(galleryId, []);
      return () => {
        cancelled = true;
      };
    }

    if (resolvedImages !== null) {
      const isNewGallery = initializedGalleryRef.current !== galleryId;
      if (!isNewGallery) {
        // React Query can replace a gallery's image array after focus/reconnect.
        // Refresh the page list without resetting the active page, mode, or the
        // user-navigation guard for this reader session.
        const current = useReaderStore.getState();
        const nextPage = clampPage(current.currentPage, resolvedImages.length);
        if (
          !sameImageList(current.images, resolvedImages) ||
          current.totalPages !== resolvedImages.length ||
          current.currentPage !== nextPage ||
          current.isLoading ||
          current.error
        ) {
          useReaderStore.setState({
            images: resolvedImages,
            totalPages: resolvedImages.length,
            currentPage: nextPage,
            isLoading: false,
            error: null,
          });
        }
      } else {
        initializedGalleryRef.current = galleryId;
        initialPageAppliedGalleryRef.current = null;
        progressResolvedGalleryRef.current = null;
        progressRequestRef.current = null;
        userNavigatedRef.current = false;
        setGallery(galleryId, resolvedImages);

        // Apply the user's preferred reader mode as the immediate default. Do
        // this even for a temporarily empty list so a later same-gallery image
        // refresh does not inherit the previous gallery's mode.
        storeSetMode(useSettingsStore.getState().readerMode);
      }

      if (resolvedImages.length === 0) {
        return () => {
          cancelled = true;
        };
      }

      if (initialPage && initialPage > 0) {
        if (initialPageAppliedGalleryRef.current !== galleryId) {
          storeSetCurrentPage(clampPage(initialPage - 1, resolvedImages.length));
          initialPageAppliedGalleryRef.current = galleryId;
        }
        progressResolvedGalleryRef.current = galleryId;
        progressRequestRef.current = null;
        markProgressReady(galleryId);
      } else if (progressResolvedGalleryRef.current !== galleryId) {
        const capturedId = galleryId;
        let request = progressRequestRef.current;
        if (!request || request.galleryId !== galleryId) {
          request = {
            galleryId,
            promise: waitForPendingReaderHistoryWrites(galleryId).then(() =>
              getReadingProgress(galleryId),
            ),
          };
          progressRequestRef.current = request;
        }

        // Re-attach to the same in-flight request after a StrictMode effect
        // replay or a same-gallery image identity refresh. The old attachment
        // is cancelled, but the request itself remains owned by this session.
        request.promise.then(
          (progress) => {
            if (
              cancelled ||
              useReaderStore.getState().galleryId !== capturedId ||
              initializedGalleryRef.current !== capturedId
            )
              return;

            progressResolvedGalleryRef.current = capturedId;
            if (
              progress &&
              // recordVisit creates a zero-page history row. It is not reading
              // progress and must not override the user's configured mode.
              progress.totalPages > 0 &&
              !userNavigatedRef.current
            ) {
              storeSetCurrentPage(
                clampPage(progress.lastPage, useReaderStore.getState().totalPages),
              );
              const restoredMode = normalizeStoredReaderMode(progress.readerMode);
              if (restoredMode) storeSetMode(restoredMode);
            }
            markProgressReady(capturedId);
          },
          () => {
            // Recoverable: DB unavailable — reader opens at the default
            // page/mode. A dead DB must not break opening the reader.
            if (
              !cancelled &&
              useReaderStore.getState().galleryId === capturedId &&
              initializedGalleryRef.current === capturedId
            ) {
              progressResolvedGalleryRef.current = capturedId;
              markProgressReady(capturedId);
            }
          },
        );
      }
    }

    return () => {
      cancelled = true;
    };
  }, [
    resolvedImages,
    galleryId,
    initialPage,
    markProgressReady,
    setGallery,
    storeSetCurrentPage,
    storeSetMode,
  ]);

  const setCurrentPage = useCallback(
    (page: number) => {
      if (useReaderStore.getState().currentPage === page) return;
      userNavigatedRef.current = true;
      progressResolvedGalleryRef.current = galleryId;
      markProgressReady(galleryId);
      storeSetCurrentPage(page);
    },
    [galleryId, markProgressReady, storeSetCurrentPage],
  );
  const setMode = useCallback(
    (nextMode: ReaderMode) => {
      userNavigatedRef.current = true;
      progressResolvedGalleryRef.current = galleryId;
      markProgressReady(galleryId);
      storeSetMode(nextMode);
    },
    [galleryId, markProgressReady, storeSetMode],
  );
  const nextPage = useCallback(
    (step?: number) => {
      userNavigatedRef.current = true;
      progressResolvedGalleryRef.current = galleryId;
      markProgressReady(galleryId);
      storeNextPage(step);
    },
    [galleryId, markProgressReady, storeNextPage],
  );
  const prevPage = useCallback(
    (step?: number) => {
      userNavigatedRef.current = true;
      progressResolvedGalleryRef.current = galleryId;
      markProgressReady(galleryId);
      storePrevPage(step);
    },
    [galleryId, markProgressReady, storePrevPage],
  );

  const { goBack } = useReaderHistory(galleryId);
  useReaderPersistence();

  // Keyboard navigation is handled in ReaderView to support both page and scroll modes

  return {
    galleryId: storeGalleryId,
    currentPage,
    totalPages,
    mode,
    images,
    isLoading: (useNetworkImages && galleryLoading) || isLoading,
    error: useNetworkImages ? galleryError?.message || error : error,
    retry: retryGallery,
    setGallery,
    setCurrentPage,
    setMode,
    nextPage,
    prevPage,
    setScrollPosition,
    goBack,
  };
}
