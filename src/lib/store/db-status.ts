import { create } from 'zustand';

interface DbStatusState {
  /** Whether the local tag DB has been populated (bulk sync completed) */
  dbReady: boolean;
  /** Sync progress 0–100 */
  syncProgress: number;
  /** Whether a sync is currently running */
  isSyncing: boolean;
  setDbReady: (ready: boolean) => void;
  setSyncProgress: (progress: number) => void;
  setIsSyncing: (syncing: boolean) => void;
}

export const useDbStatusStore = create<DbStatusState>()((set) => ({
  dbReady: false,
  syncProgress: 0,
  isSyncing: false,
  setDbReady: (ready) => set({ dbReady: ready }),
  setSyncProgress: (progress) => set({ syncProgress: progress }),
  setIsSyncing: (syncing) => set({ isSyncing: syncing }),
}));
