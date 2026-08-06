import { create } from 'zustand';
import type { DownloadProgress } from '@/lib/utils/download-zip';

export interface ActiveZipExport extends DownloadProgress {
  token: number;
  galleryId: number;
  title: string;
}

export type ZipExportNotice =
  | { kind: 'saved' | 'started'; galleryId: number; title: string }
  | {
      kind: 'error';
      galleryId: number;
      title: string;
      reason: 'source' | 'storage';
    };

interface ZipExportState {
  active: ActiveZipExport | null;
  notice: ZipExportNotice | null;
  deletingGalleryIds: ReadonlySet<number>;
  begin: (galleryId: number, title: string) => number | null;
  claimDelete: (galleryId: number) => boolean;
  releaseDelete: (galleryId: number) => void;
  updateProgress: (token: number, progress: DownloadProgress) => void;
  finish: (token: number, kind: 'saved' | 'started') => void;
  fail: (token: number, reason: 'source' | 'storage') => void;
  cancel: (token: number) => void;
  clearNotice: () => void;
  reset: () => void;
}

let nextToken = 0;
const deleteClaimGenerations = new Map<number, number>();

/**
 * Monotonic per-gallery deletion epoch. Async queue/start work captures this
 * before awaiting and can detect a deletion that began and finished while it
 * was suspended, even after `deletingGalleryIds` no longer contains the id.
 */
export function getDeleteClaimGeneration(galleryId: number): number {
  return deleteClaimGenerations.get(galleryId) ?? 0;
}

/**
 * Process-wide single-flight state. Keeping export and deletion claims outside
 * DownloadsView means navigation cannot re-enable either side while the other
 * is using that gallery's files, and stale async callbacks cannot settle a
 * newer export job.
 */
export const useZipExportStore = create<ZipExportState>((set, get) => ({
  active: null,
  notice: null,
  deletingGalleryIds: new Set(),

  begin: (galleryId, title) => {
    const state = get();
    if (state.active || state.deletingGalleryIds.has(galleryId)) return null;
    const token = ++nextToken;
    set({
      active: { token, galleryId, title, current: 0, total: 0 },
      notice: null,
    });
    return token;
  },

  claimDelete: (galleryId) => {
    const state = get();
    if (state.active?.galleryId === galleryId || state.deletingGalleryIds.has(galleryId)) {
      return false;
    }
    const deletingGalleryIds = new Set(state.deletingGalleryIds);
    deletingGalleryIds.add(galleryId);
    deleteClaimGenerations.set(galleryId, getDeleteClaimGeneration(galleryId) + 1);
    set({ deletingGalleryIds });
    return true;
  },

  releaseDelete: (galleryId) =>
    set((state) => {
      if (!state.deletingGalleryIds.has(galleryId)) return state;
      const deletingGalleryIds = new Set(state.deletingGalleryIds);
      deletingGalleryIds.delete(galleryId);
      return { deletingGalleryIds };
    }),

  updateProgress: (token, progress) =>
    set((state) =>
      state.active?.token === token ? { active: { ...state.active, ...progress } } : state,
    ),

  finish: (token, kind) =>
    set((state) => {
      if (state.active?.token !== token) return state;
      const { galleryId, title } = state.active;
      return { active: null, notice: { kind, galleryId, title } };
    }),

  fail: (token, reason) =>
    set((state) => {
      if (state.active?.token !== token) return state;
      const { galleryId, title } = state.active;
      return { active: null, notice: { kind: 'error', galleryId, title, reason } };
    }),

  cancel: (token) =>
    set((state) => (state.active?.token === token ? { active: null, notice: null } : state)),
  clearNotice: () => set({ notice: null }),
  reset: () => set({ active: null, notice: null, deletingGalleryIds: new Set() }),
}));
