import { setDb, isDbInitialized, setEnsureInit } from './adapter';
import type { DbAdapter } from './adapter';
import { SCHEMA_SQL } from './schema-sql';
import { runMigrations } from './migrations';
import { isTauri, isCapacitor } from '@/lib/utils/platform';
import { useDbStatusStore } from '@/lib/store/db-status';

// Diagnostic only — record the current init step so a hang (which never throws,
// so DbErrorBanner never fires) leaves the stuck stage visible in the UI. No
// timeout/abort: the separate tag bulk-sync may legitimately be slow and is not
// instrumented here.
function setStage(stage: string | null): void {
  try {
    useDbStatusStore.getState().setDbInitStage(stage);
  } catch {
    /* store unavailable (non-React context) — diagnostics are best-effort */
  }
}

// === DB Entity Interfaces ===

export interface DBGallery {
  id: number;           // PK (gallery ID from API)
  type: number;         // GalleryBlockType as byte
  title: string;
  date: string;         // ISO string
  thumbnail: string;
  url: string;          // gallery URL
  language: string;
  mediaType: string;
  updatedAt: string;    // cache timestamp
}

export interface DBGalleryRelate {
  idx?: number;         // PK auto-increment
  id: number;           // FK -> gallery.id
  related: number;      // related gallery ID
}

export interface DBTag {
  tagId?: number;       // PK auto-increment
  type: number;         // TagType byte
  name: string;
  count: number;        // usage count
}

export interface DBTagI18n {
  tagId: number;        // PK, FK -> tag.tagId
  local: string;        // localized name
}

export interface DBTagTransform {
  original: string;     // PK
  transformed: string;
}

export interface DBGalleryTag {
  id: number;           // FK -> gallery.id
  tagId: number;        // FK -> tag.tagId
}

export interface DBSyncStatus {
  tag: string;          // PK
  data: string;         // JSON payload
}

export interface DBFavorite {
  id?: number;
  galleryId: number;
  addedAt: string;
}

export interface DBHistory {
  id?: number;
  galleryId: number;
  lastPage: number;
  totalPages: number;
  readerMode: string;
  viewedAt: string;
}

export interface DBGalleryImage {
  id?: number;
  galleryId: number;
  pageIndex: number;
  width: number;
  height: number;
  haswebp: number;
  hasavif: number;
  hasavifsmalltn: number;
  name: string;
  hash: string;
}

export type DownloadStatus = 'downloading' | 'complete' | 'failed';

export interface DBDownload {
  galleryId: number;    // PK
  title: string;
  thumbnail: string;
  tags: string;         // JSON-serialized tag map
  pageCount: number;
  totalBytes: number;
  downloadedAt: string; // ISO string
  status: DownloadStatus;
  folderName?: string | null;
  migratedAt?: string | null;
}

// === Database Initialization ===

let _initPromise: Promise<void> | null = null;

/**
 * Initialize the database by detecting the platform and creating the appropriate adapter.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initializeDatabase(): Promise<void> {
  if (isDbInitialized()) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const adapter = await detectPlatformAdapter();
    setStage('creating tables');
    await adapter.exec(SCHEMA_SQL);
    setStage('running migrations');
    await runMigrations(adapter);
    setDb(adapter);
    setStage(null);
  })();

  return _initPromise;
}

// Register initializer so ensureDb() can auto-init
setEnsureInit(() => initializeDatabase());

export async function detectPlatformAdapter(): Promise<DbAdapter> {
  if (typeof window === 'undefined') {
    throw new Error('No SQLite platform detected.');
  }

  // Use the canonical platform predicates, NOT raw global existence checks:
  // `@capacitor/core` injects `window.Capacitor` on plain web too, and Tauri 2
  // exposes `__TAURI_INTERNALS__` (not the v1 `__TAURI__`). A bare `'Capacitor'
  // in window` / `'__TAURI__' in window` check therefore mis-routes web AND
  // desktop to the Capacitor adapter, whose native SQLite plugin is absent off
  // device — that crash was silently swallowed and left history/favorites empty.

  setStage('selecting adapter');

  // Tauri desktop (Tauri 2 global)
  if (isTauri()) {
    const { TauriAdapter } = await import('./adapters/tauri');
    setStage('opening connection (tauri)');
    return TauriAdapter.create();
  }

  // Capacitor mobile (native only — isNativePlatform() is false on web)
  if (isCapacitor()) {
    const { CapacitorAdapter } = await import('./adapters/capacitor');
    setStage('opening connection (capacitor)');
    return CapacitorAdapter.create();
  }

  // Browser — WASM SQLite with IndexedDB persistence
  const { WebAdapter } = await import('./adapters/web');
  setStage('opening connection (web)');
  return WebAdapter.create();
}
