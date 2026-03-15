import { setDb, isDbInitialized, setEnsureInit } from './adapter';
import type { DbAdapter } from './adapter';
import { SCHEMA_SQL } from './schema-sql';
import { runMigrations } from './migrations';

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
    await adapter.exec(SCHEMA_SQL);
    await runMigrations(adapter);
    setDb(adapter);
  })();

  return _initPromise;
}

// Register initializer so ensureDb() can auto-init
setEnsureInit(() => initializeDatabase());

async function detectPlatformAdapter(): Promise<DbAdapter> {
  // Tauri desktop
  if (typeof window !== 'undefined' && '__TAURI__' in window) {
    const { TauriAdapter } = await import('./adapters/tauri');
    return TauriAdapter.create();
  }

  // Capacitor mobile
  if (typeof window !== 'undefined' && 'Capacitor' in window) {
    const { CapacitorAdapter } = await import('./adapters/capacitor');
    return CapacitorAdapter.create();
  }

  // Browser — WASM SQLite with IndexedDB persistence
  if (typeof window !== 'undefined') {
    const { WebAdapter } = await import('./adapters/web');
    return WebAdapter.create();
  }

  throw new Error('No SQLite platform detected.');
}
