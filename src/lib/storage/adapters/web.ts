/**
 * Web DownloadStore adapter.
 *
 * Primary backend for new installs: OPFS (Origin Private File System via
 * navigator.storage.getDirectory()). Each gallery is a sub-directory; each
 * image is a file inside it.
 *
 * Legacy/fallback backend: IndexedDB blob store — used when OPFS is absent
 * (older browsers, jsdom test environment). Keys are
 * "<galleryId>/<filename>"; galleries are enumerated by scanning keys.
 *
 * The selected backend is sticky. A browser gaining OPFS support must keep
 * reading an existing IndexedDB library, and a transient OPFS failure must not
 * silently switch an existing OPFS installation to an empty IndexedDB store.
 */

import type { DownloadStore } from '../download-store';
import { imageFileName, galleryFolderName } from '../download-store';

type WebDownloadBackendKind = 'opfs' | 'idb';

const BACKEND_CHOICE_KEY = 'hipago:web-download-backend:v1';

function readBackendChoice(): WebDownloadBackendKind | null {
  try {
    const value = globalThis.localStorage?.getItem(BACKEND_CHOICE_KEY);
    return value === 'opfs' || value === 'idb' ? value : null;
  } catch {
    // localStorage can be blocked in private/embedded contexts. The markerless
    // selection path still probes legacy IndexedDB data before choosing OPFS.
    return null;
  }
}

function rememberBackendChoice(choice: WebDownloadBackendKind): void {
  try {
    globalThis.localStorage?.setItem(BACKEND_CHOICE_KEY, choice);
  } catch {
    // Best effort. On the next launch, content probing makes the same safe
    // choice even when the preference store itself is unavailable.
  }
}

function supportsOpfs(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    navigator.storage !== undefined &&
    typeof navigator.storage.getDirectory === 'function'
  );
}

/** Only genuine absence is benign; permission and I/O failures must propagate. */
function isNotFoundError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    if ('name' in error && (error as { name?: unknown }).name === 'NotFoundError') return true;
    if ('code' in error && (error as { code?: unknown }).code === 'ENOENT') return true;
  }

  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return /\bENOENT\b/i.test(message);
}

// ── OPFS backend ───────────────────────────────────────────────────────────

class OpfsStore implements DownloadStore {
  private root: FileSystemDirectoryHandle;

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
  }

  private async galleryDir(galleryId: number, create = false): Promise<FileSystemDirectoryHandle> {
    return this.root.getDirectoryHandle(galleryFolderName(galleryId), {
      create,
    });
  }

  async putImage(galleryId: number, index: number, bytes: Uint8Array, ext: string): Promise<void> {
    const dir = await this.galleryDir(galleryId, true);
    const fh = await dir.getFileHandle(imageFileName(index, ext), {
      create: true,
    });
    const writable = await fh.createWritable();
    // `bytes` can be a sub-view of a larger response buffer. Copy the view so
    // OPFS receives exactly byteOffset..byteLength, never unrelated prefix or
    // suffix bytes from the backing ArrayBuffer.
    const exactBuffer =
      bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength &&
      bytes.buffer instanceof ArrayBuffer
        ? bytes.buffer
        : (bytes.slice().buffer as ArrayBuffer);
    await writable.write(new Blob([exactBuffer]));
    await writable.close();
  }

  async getImage(galleryId: number, index: number, ext: string): Promise<Uint8Array | null> {
    try {
      const dir = await this.galleryDir(galleryId);
      const fh = await dir.getFileHandle(imageFileName(index, ext));
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      return null;
    }
  }

  async imageExists(galleryId: number, index: number, ext: string): Promise<boolean> {
    try {
      const dir = await this.galleryDir(galleryId);
      const fh = await dir.getFileHandle(imageFileName(index, ext));
      // getFile() exposes the size without reading the bytes into the heap.
      const file = await fh.getFile();
      return file.size > 0;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      return false;
    }
  }

  async listGalleries(): Promise<number[]> {
    const ids: number[] = [];
    // FileSystemDirectoryHandle async iterator — cast to any for TS compat
    // (entries() is not declared in this TypeScript version's lib.dom.d.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const [name, handle] of this.root as any) {
      if (handle && (handle.kind === 'directory' || handle.children !== undefined)) {
        const id = parseInt(name, 10);
        if (!isNaN(id)) ids.push(id);
      }
    }
    return ids;
  }

  async deleteGallery(galleryId: number): Promise<void> {
    try {
      await this.root.removeEntry(galleryFolderName(galleryId), {
        recursive: true,
      });
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      // Already gone — treat as success.
    }
  }

  async gallerySize(galleryId: number): Promise<number> {
    try {
      const dir = await this.galleryDir(galleryId);
      let total = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const [, handle] of dir as any) {
        if (handle && handle.kind === 'file') {
          const file = await (handle as FileSystemFileHandle).getFile();
          total += file.size;
        }
      }
      return total;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      return 0;
    }
  }

  async usage(): Promise<number> {
    const ids = await this.listGalleries();
    let total = 0;
    for (const id of ids) {
      total += await this.gallerySize(id);
    }
    return total;
  }
}

// ── IndexedDB fallback backend ─────────────────────────────────────────────

const IDB_NAME = 'hipago-downloads';
const IDB_STORE = 'images';

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Key format: "<galleryId>/<filename>" */
function idbKey(galleryId: number, index: number, ext: string): string {
  return `${galleryFolderName(galleryId)}/${imageFileName(index, ext)}`;
}

class IdbStore implements DownloadStore {
  private db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  private tx(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(IDB_STORE, mode).objectStore(IDB_STORE);
  }

  async putImage(galleryId: number, index: number, bytes: Uint8Array, ext: string): Promise<void> {
    const store = this.tx('readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(bytes, idbKey(galleryId, index, ext));
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async getImage(galleryId: number, index: number, ext: string): Promise<Uint8Array | null> {
    const store = this.tx('readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(idbKey(galleryId, index, ext));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async imageExists(galleryId: number, index: number, ext: string): Promise<boolean> {
    // IndexedDB cannot report a stored value's size without retrieving it, so
    // read the value and check its byte length (treating empty as missing).
    const store = this.tx('readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(idbKey(galleryId, index, ext));
      req.onsuccess = () => {
        const val: Uint8Array | undefined = req.result;
        resolve(!!val && val.byteLength > 0);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async listGalleries(): Promise<number[]> {
    const store = this.tx('readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAllKeys();
      req.onsuccess = () => {
        const keys = req.result as string[];
        const idSet = new Set<number>();
        for (const key of keys) {
          const slash = key.indexOf('/');
          if (slash > 0) {
            const id = parseInt(key.slice(0, slash), 10);
            if (!isNaN(id)) idSet.add(id);
          }
        }
        resolve([...idSet]);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async deleteGallery(galleryId: number): Promise<void> {
    const prefix = `${galleryFolderName(galleryId)}/`;
    const db = this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        const keys = req.result as string[];
        for (const key of keys) {
          if (key.startsWith(prefix)) store.delete(key);
        }
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async gallerySize(galleryId: number): Promise<number> {
    const prefix = `${galleryFolderName(galleryId)}/`;
    const db = this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const keysReq = store.getAllKeys();
      keysReq.onsuccess = () => {
        const keys = (keysReq.result as string[]).filter((k) => k.startsWith(prefix));
        if (keys.length === 0) {
          resolve(0);
          return;
        }
        let total = 0;
        let pending = keys.length;
        for (const key of keys) {
          const r = store.get(key);
          r.onsuccess = () => {
            const val: Uint8Array | undefined = r.result;
            total += val ? val.byteLength : 0;
            if (--pending === 0) resolve(total);
          };
          r.onerror = () => reject(r.error);
        }
      };
      keysReq.onerror = () => reject(keysReq.error);
    });
  }

  async usage(): Promise<number> {
    const ids = await this.listGalleries();
    let total = 0;
    for (const id of ids) total += await this.gallerySize(id);
    return total;
  }
}

// ── Public adapter ─────────────────────────────────────────────────────────

export class WebDownloadStore implements DownloadStore {
  private backend: DownloadStore;

  private constructor(backend: DownloadStore) {
    this.backend = backend;
  }

  /**
   * Create the adapter without allowing backend drift:
   *
   * 1. Honour a previously persisted choice. A selected OPFS backend fails
   *    closed when OPFS is temporarily unavailable instead of exposing an empty
   *    IndexedDB library.
   * 2. For pre-marker installs, probe IndexedDB first. If it contains any
   *    gallery, keep using it even when a browser update has added OPFS.
   * 3. New installs use OPFS when the API exists, otherwise IndexedDB.
   *
   * An OPFS API rejection is intentionally not treated like API absence. A
   * rejection can be transient, and falling back in that state can hide an
   * existing OPFS library or split new downloads across two backends.
   */
  static async create(): Promise<WebDownloadStore> {
    const remembered = readBackendChoice();

    if (remembered === 'opfs') {
      if (!supportsOpfs()) {
        throw new Error('The selected OPFS download storage backend is unavailable');
      }
      const root = await navigator.storage.getDirectory();
      return new WebDownloadStore(new OpfsStore(root));
    }

    if (remembered === 'idb') {
      const db = await openIDB();
      return new WebDownloadStore(new IdbStore(db));
    }

    // Legacy installs predate the sticky marker. Probe the old IndexedDB store
    // before considering OPFS so newly available OPFS cannot hide real data.
    let idbBackend: IdbStore | null = null;
    if (typeof indexedDB !== 'undefined') {
      const db = await openIDB();
      idbBackend = new IdbStore(db);
      if ((await idbBackend.listGalleries()).length > 0) {
        rememberBackendChoice('idb');
        return new WebDownloadStore(idbBackend);
      }
    }

    if (supportsOpfs()) {
      const root = await navigator.storage.getDirectory();
      rememberBackendChoice('opfs');
      return new WebDownloadStore(new OpfsStore(root));
    }

    if (!idbBackend) {
      const db = await openIDB();
      idbBackend = new IdbStore(db);
    }
    rememberBackendChoice('idb');
    return new WebDownloadStore(idbBackend);
  }

  /** Create with an explicit backend — used in tests. */
  static withBackend(backend: DownloadStore): WebDownloadStore {
    return new WebDownloadStore(backend);
  }

  putImage(galleryId: number, index: number, bytes: Uint8Array, ext: string): Promise<void> {
    return this.backend.putImage(galleryId, index, bytes, ext);
  }

  getImage(galleryId: number, index: number, ext: string): Promise<Uint8Array | null> {
    return this.backend.getImage(galleryId, index, ext);
  }

  imageExists(galleryId: number, index: number, ext: string): Promise<boolean> {
    // Both OPFS and IDB backends implement imageExists; the `?? false` keeps the
    // facade total even if a future backend omits it.
    return this.backend.imageExists?.(galleryId, index, ext) ?? Promise.resolve(false);
  }

  listGalleries(): Promise<number[]> {
    return this.backend.listGalleries();
  }

  deleteGallery(galleryId: number): Promise<void> {
    return this.backend.deleteGallery(galleryId);
  }

  gallerySize(galleryId: number): Promise<number> {
    return this.backend.gallerySize(galleryId);
  }

  usage(): Promise<number> {
    return this.backend.usage();
  }
}
