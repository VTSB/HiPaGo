import { create } from 'zustand';

interface DbStatusState {
  /** Whether the local tag DB has been populated (bulk sync completed) */
  dbReady: boolean;
  /** Sync progress 0–100 */
  syncProgress: number;
  /** Whether a sync is currently running */
  isSyncing: boolean;
  /** Human-readable detail string for current sync step */
  syncDetail: string;
  /** Whether tags are older than 7 days and should be refreshed */
  tagsStale: boolean;
  /** Error message from the last failed tag sync, or null if none / cleared */
  syncError: string | null;
  /** Error message from a failed local-DB init (blocks history/favorites), or null. */
  dbError: string | null;
  /** Current local-DB init step (e.g. "opening connection (capacitor)"), or null when idle/done.
   *  Diagnostic only: on a hang the last stage stays set so the UI can show where it stuck. */
  dbInitStage: string | null;
  setDbReady: (ready: boolean) => void;
  setSyncProgress: (progress: number) => void;
  setIsSyncing: (syncing: boolean) => void;
  setSyncDetail: (detail: string) => void;
  setTagsStale: (stale: boolean) => void;
  setSyncError: (error: string | null) => void;
  setDbError: (error: string | null) => void;
  setDbInitStage: (stage: string | null) => void;
}

export const useDbStatusStore = create<DbStatusState>()((set) => ({
  dbReady: false,
  syncProgress: 0,
  isSyncing: false,
  syncDetail: '',
  tagsStale: false,
  syncError: null,
  dbError: null,
  dbInitStage: null,
  setDbReady: (ready) => set({ dbReady: ready }),
  setSyncProgress: (progress) => set({ syncProgress: progress }),
  setIsSyncing: (syncing) => set({ isSyncing: syncing }),
  setSyncDetail: (detail) => set({ syncDetail: detail }),
  setTagsStale: (stale) => set({ tagsStale: stale }),
  setSyncError: (error) => set({ syncError: error }),
  setDbError: (error) => set({ dbError: error }),
  setDbInitStage: (stage) => set({ dbInitStage: stage }),
}));
