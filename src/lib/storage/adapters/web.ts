/**
 * Web DownloadStore adapter.
 *
 * Primary backend: OPFS (Origin Private File System via
 * navigator.storage.getDirectory()).  Each gallery is a sub-directory;
 * each image is a file inside it.
 *
 * Fallback backend: IndexedDB blob store — used when OPFS is unavailable
 * (older browsers, jsdom test environment).  Keys are
 * "<galleryId>/<filename>"; galleries are enumerated by scanning keys.
 */

import type { DownloadStore } from '../download-store';
import { imageFileName, galleryFolderName } from '../download-store';

// ── OPFS backend ───────────────────────────────────────────────────────────

class OpfsStore implements DownloadStore {
  private root: FileSystemDirectoryHandle;

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
  }

  private async galleryDir(
    galleryId: number,
    create = false,
  ): Promise<FileSystemDirectoryHandle> {
    return this.root.getDirectoryHandle(galleryFolderName(galleryId), {
      create,
    });
  }

  async putImage(
    galleryId: number,
    index: number,
    bytes: Uint8Array,
    ext: string,
  ): Promise<void> {
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

  async getImage(
    galleryId: number,
    index: number,
    ext: string,
  ): Promise<Uint8Array | null> {
    try {
      const dir = await this.galleryDir(galleryId);
      const fh = await dir.getFileHandle(imageFileName(index, ext));
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async imageExists(
    galleryId: number,
    index: number,
    ext: string,
  ): Promise<boolean> {
    try {
      const dir = await this.galleryDir(galleryId);
      const fh = await dir.getFileHandle(imageFileName(index, ext));
      // getFile() exposes the size without reading the bytes into the heap.
      const file = await fh.getFile();
      return file.size > 0;
    } catch {
      return false;
    }
  }

  async listGalleries(): Promise<number[]> {
    const ids: number[] = [];
    // FileSystemDirectoryHandle async iterator — cast to any for TS compat
    // (entries() is not declared in this TypeScript version's lib.dom.d.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const [name, handle] of this.root as any) {
      if (
        handle &&
        (handle.kind === 'directory' || handle.children !== undefined)
      ) {
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
    } catch {
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
    } catch {
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

  async putImage(
    galleryId: number,
    index: number,
    bytes: Uint8Array,
    ext: string,
  ): Promise<void> {
    const store = this.tx('readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(bytes, idbKey(galleryId, index, ext));
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async getImage(
    galleryId: number,
    index: number,
    ext: string,
  ): Promise<Uint8Array | null> {
    const store = this.tx('readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(idbKey(galleryId, index, ext));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async imageExists(
    galleryId: number,
    index: number,
    ext: string,
  ): Promise<boolean> {
    // IndexedDB cannot report a stored value's size without retrieving it, so
    // read the value and check its byte length (treating empty as missing).
    const store = this.tx('readonly');
    return new Promise((resolve) => {
      const req = store.get(idbKey(galleryId, index, ext));
      req.onsuccess = () => {
        const val: Uint8Array | undefined = req.result;
        resolve(!!val && val.byteLength > 0);
      };
      req.onerror = () => resolve(false);
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
        const keys = (keysReq.result as string[]).filter((k) =>
          k.startsWith(prefix),
        );
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
   * Create the adapter: try OPFS first; fall back to IndexedDB if OPFS is
   * unavailable (older browsers, test environments).
   */
  static async create(): Promise<WebDownloadStore> {
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.storage &&
        typeof navigator.storage.getDirectory === 'function'
      ) {
        const root = await navigator.storage.getDirectory();
        return new WebDownloadStore(new OpfsStore(root));
      }
    } catch {
      // OPFS not available — fall through to IndexedDB.
    }
    const db = await openIDB();
    return new WebDownloadStore(new IdbStore(db));
  }

  /** Create with an explicit backend — used in tests. */
  static withBackend(backend: DownloadStore): WebDownloadStore {
    return new WebDownloadStore(backend);
  }

  putImage(
    galleryId: number,
    index: number,
    bytes: Uint8Array,
    ext: string,
  ): Promise<void> {
    return this.backend.putImage(galleryId, index, bytes, ext);
  }

  getImage(
    galleryId: number,
    index: number,
    ext: string,
  ): Promise<Uint8Array | null> {
    return this.backend.getImage(galleryId, index, ext);
  }

  imageExists(
    galleryId: number,
    index: number,
    ext: string,
  ): Promise<boolean> {
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
