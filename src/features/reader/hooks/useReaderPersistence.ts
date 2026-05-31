'use client';

import { useEffect, useRef } from 'react';
import { useReaderStore } from '@/features/reader/store/reader.store';
import { recordHistory } from '@/lib/db/gallery';

/**
 * Debounced reading progress persistence.
 * Saves after 2s of no page changes, and on unmount.
 */
export function useReaderPersistence() {
  const storeGalleryId = useReaderStore((s) => s.galleryId);
  const currentPage = useReaderStore((s) => s.currentPage);
  const totalPages = useReaderStore((s) => s.totalPages);
  const mode = useReaderStore((s) => s.mode);

  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latestState = useRef({ currentPage, totalPages, mode, storeGalleryId });
  // Keep the latest values in a ref so the debounced/unmount saves always use
  // the current state without re-subscribing effects. Assigned in an effect,
  // not during render (react-hooks/refs).
  useEffect(() => {
    latestState.current = { currentPage, totalPages, mode, storeGalleryId };
  });

  // Debounced save — only persist after 2s of no page changes
  useEffect(() => {
    if (!storeGalleryId) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const { storeGalleryId: id, currentPage: p, totalPages: t, mode: m } = latestState.current;
      // Fire-and-forget: a dead DB must not raise an unhandled rejection.
      if (id) recordHistory(id, p, t, m).catch(() => {});
    }, 2000);
    return () => clearTimeout(saveTimer.current);
  }, [currentPage, storeGalleryId]);

  // Save on unmount (leaving reader)
  useEffect(() => {
    return () => {
      clearTimeout(saveTimer.current);
      const { storeGalleryId: id, currentPage: p, totalPages: t, mode: m } = latestState.current;
      // Fire-and-forget: a dead DB must not raise an unhandled rejection.
      if (id) recordHistory(id, p, t, m).catch(() => {});
    };
  }, []);
}
