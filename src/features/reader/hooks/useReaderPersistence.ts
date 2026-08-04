'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useReaderStore } from '@/features/reader/store/reader.store';
import { recordHistory } from '@/lib/db/gallery';

type ReaderSnapshot = {
  storeGalleryId: number | null;
  currentPage: number;
  totalPages: number;
  mode: 'page' | 'scroll';
  progressReadyGalleryId: number | null;
};

function readReaderSnapshot(): ReaderSnapshot {
  const { galleryId, currentPage, totalPages, mode, progressReadyGalleryId } =
    useReaderStore.getState();
  return { storeGalleryId: galleryId, currentPage, totalPages, mode, progressReadyGalleryId };
}

type ReaderHistoryLane = {
  inFlight: boolean;
  inFlightKey: string | null;
  pending: ReaderSnapshot | null;
  pendingKey: string | null;
  lastCompletedKey: string | null;
  deferredFlushes: number;
  idleWaiters: Set<() => void>;
};

const readerHistoryLanes = new Map<number, ReaderHistoryLane>();

function persistableGalleryId(snapshot: ReaderSnapshot): number | null {
  const { storeGalleryId: id, totalPages, progressReadyGalleryId: readyId } = snapshot;
  return id && totalPages > 0 && readyId === id ? id : null;
}

function getReaderHistoryLane(galleryId: number): ReaderHistoryLane {
  let lane = readerHistoryLanes.get(galleryId);
  if (!lane) {
    lane = {
      inFlight: false,
      inFlightKey: null,
      pending: null,
      pendingKey: null,
      lastCompletedKey: null,
      deferredFlushes: 0,
      idleWaiters: new Set(),
    };
    readerHistoryLanes.set(galleryId, lane);
  }
  return lane;
}

function releaseIdleWaiters(lane: ReaderHistoryLane): void {
  if (lane.inFlight || lane.pending || lane.deferredFlushes > 0) return;
  for (const resolve of lane.idleWaiters) resolve();
  lane.idleWaiters.clear();
}

async function runReaderHistoryLane(lane: ReaderHistoryLane): Promise<void> {
  if (lane.inFlight) return;

  lane.inFlight = true;
  try {
    while (lane.pending) {
      const snapshot = lane.pending;
      const stateKey = lane.pendingKey!;
      lane.pending = null;
      lane.pendingKey = null;
      lane.inFlightKey = stateKey;

      const {
        storeGalleryId: id,
        currentPage: page,
        totalPages: total,
        mode: readerMode,
      } = snapshot;
      try {
        await recordHistory(id!, page, total, readerMode);
        lane.lastCompletedKey = stateKey;

        // A lifecycle event may request the exact same snapshot while this
        // write is in flight. The duplicate is only redundant after the
        // active write succeeds; if it fails, leave the queued copy in place
        // so that event still gets its retry attempt.
        if (lane.pendingKey === stateKey) {
          lane.pending = null;
          lane.pendingKey = null;
        }
      } catch {
        // A later lifecycle event may enqueue the same snapshot again. Do not
        // mark a failed write as completed.
      } finally {
        lane.inFlightKey = null;
      }
    }
  } finally {
    lane.inFlight = false;
    releaseIdleWaiters(lane);
  }
}

function persistReaderSnapshot(snapshot: ReaderSnapshot): void {
  const id = persistableGalleryId(snapshot);
  // Never write the page-0/default-mode seed while useReader is still reading
  // the existing progress row.
  if (!id) return;

  const stateKey = `${id}:${snapshot.currentPage}:${snapshot.totalPages}:${snapshot.mode}`;
  const lane = getReaderHistoryLane(id);
  if (lane.inFlightKey === stateKey) {
    lane.pending = snapshot;
    lane.pendingKey = stateKey;
    return;
  }
  if (lane.pendingKey === stateKey || (!lane.inFlight && lane.lastCompletedKey === stateKey))
    return;

  // One lane survives ReaderView remounts and keeps only the latest snapshot
  // behind the active native/database write.
  lane.pending = snapshot;
  lane.pendingKey = stateKey;
  void runReaderHistoryLane(lane);
}

function reserveDeferredReaderFlush(snapshot: ReaderSnapshot): (shouldPersist: boolean) => void {
  const id = persistableGalleryId(snapshot);
  if (!id) return () => {};

  const lane = getReaderHistoryLane(id);
  lane.deferredFlushes += 1;
  let released = false;
  return (shouldPersist) => {
    if (released) return;
    released = true;
    if (shouldPersist) persistReaderSnapshot(snapshot);
    lane.deferredFlushes -= 1;
    releaseIdleWaiters(lane);
  };
}

/** Wait until older writes and deferred unmount flushes for this gallery finish. */
export function waitForPendingReaderHistoryWrites(galleryId: number): Promise<void> {
  const lane = readerHistoryLanes.get(galleryId);
  if (!lane || (!lane.inFlight && !lane.pending && lane.deferredFlushes === 0)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => lane.idleWaiters.add(resolve));
}

/** Test-only isolation for the module-level per-gallery lanes. */
export function __resetReaderHistoryLanesForTests(): void {
  for (const lane of readerHistoryLanes.values()) {
    for (const resolve of lane.idleWaiters) resolve();
  }
  readerHistoryLanes.clear();
}

/**
 * Debounced reading progress persistence.
 * Saves after 2s of no progress-affecting changes and before the reader is
 * suspended or unmounted.
 */
export function useReaderPersistence() {
  const storeGalleryId = useReaderStore((s) => s.galleryId);
  const currentPage = useReaderStore((s) => s.currentPage);
  const totalPages = useReaderStore((s) => s.totalPages);
  const mode = useReaderStore((s) => s.mode);
  const progressReadyGalleryId = useReaderStore((s) => s.progressReadyGalleryId);

  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mountLifecycle = useRef({ generation: 0 });

  const flush = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = undefined;

    // Lifecycle events can fire in the same event turn as a Zustand update,
    // before React has rendered or run passive effects. Read the store here so
    // pagehide/visibility/unmount always persist the actual current snapshot.
    persistReaderSnapshot(readReaderSnapshot());
  }, []);

  // A reader can switch galleries without unmounting. Capture the previous
  // Zustand snapshot synchronously because reading the store after the switch
  // would permanently lose that gallery's last page and mode.
  useEffect(
    () =>
      useReaderStore.subscribe((state, previousState) => {
        if (state.galleryId === previousState.galleryId) return;

        clearTimeout(saveTimer.current);
        saveTimer.current = undefined;
        persistReaderSnapshot({
          storeGalleryId: previousState.galleryId,
          currentPage: previousState.currentPage,
          totalPages: previousState.totalPages,
          mode: previousState.mode,
          progressReadyGalleryId: previousState.progressReadyGalleryId,
        });
      }),
    [],
  );

  // Persist after 2s with no page, mode, page-count, or gallery changes.
  useEffect(() => {
    clearTimeout(saveTimer.current);
    if (!storeGalleryId || totalPages <= 0 || progressReadyGalleryId !== storeGalleryId) return;
    saveTimer.current = setTimeout(flush, 2000);
    return () => clearTimeout(saveTimer.current);
  }, [currentPage, totalPages, mode, storeGalleryId, progressReadyGalleryId, flush]);

  // Mobile WebViews and desktop windows may be destroyed without React first
  // unmounting the reader. Flush while the document is still alive.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onPageHide = () => flush();

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [flush]);

  // Save on a real unmount (leaving reader). React StrictMode replays effect
  // setup/cleanup without unmounting the component; defer the write by one
  // microtask so the replacement setup can invalidate that simulated cleanup.
  useEffect(() => {
    const lifecycle = mountLifecycle.current;
    const generation = ++lifecycle.generation;
    return () => {
      clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
      const snapshot = readReaderSnapshot();
      const releaseDeferredFlush = reserveDeferredReaderFlush(snapshot);
      void Promise.resolve().then(() => {
        releaseDeferredFlush(lifecycle.generation === generation);
      });
    };
  }, []);
}
