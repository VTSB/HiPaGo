/**
 * Web ImageCacheBackend — IndexedDB (`hipago-image-cache`), the browser-managed
 * evictable store (the web equivalent of an OS cache dir). Separate DB from the
 * `hipago-downloads` store used for explicit downloads. Two object stores:
 * `blobs` (key -> Uint8Array) and `meta` (single `index` record).
 */
import type { ImageCacheBackend, ImageCacheIndexEntry } from '../image-cache-store';

const DB_NAME = 'hipago-image-cache';
const BLOBS = 'blobs';
const META = 'meta';
const META_KEY = 'index';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function createWebImageCacheBackend(): Promise<ImageCacheBackend> {
  const db = await openDB();
  const objStore = (name: string, mode: IDBTransactionMode): IDBObjectStore =>
    db.transaction(name, mode).objectStore(name);

  return {
    async read(key) {
      const v = await reqP(objStore(BLOBS, 'readonly').get(key));
      return (v as Uint8Array | undefined) ?? null;
    },
    async write(key, bytes) {
      await reqP(objStore(BLOBS, 'readwrite').put(bytes, key));
    },
    async remove(key) {
      await reqP(objStore(BLOBS, 'readwrite').delete(key));
    },
    async loadIndex() {
      const v = await reqP(objStore(META, 'readonly').get(META_KEY));
      return (v as ImageCacheIndexEntry[] | undefined) ?? [];
    },
    async saveIndex(entries) {
      await reqP(objStore(META, 'readwrite').put(entries, META_KEY));
    },
    async clearAll() {
      await reqP(objStore(BLOBS, 'readwrite').clear());
      await reqP(objStore(META, 'readwrite').clear());
    },
  };
}
