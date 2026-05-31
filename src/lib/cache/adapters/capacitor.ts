/**
 * Capacitor ImageCacheBackend — blobs in the OS CACHE directory
 * (`Directory.Cache`), NOT the persistent `Directory.Data` used by downloads.
 * Layout: <Cache>/image-cache/<safeKey>, index at <Cache>/image-cache/index.json
 */
import type { ImageCacheBackend, ImageCacheIndexEntry } from '../image-cache-store';

const DIR = 'image-cache';
const INDEX_FILE = `${DIR}/index.json`;

/** Cache keys are opaque; map to a filesystem-safe filename. */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

export async function createCapacitorImageCacheBackend(): Promise<ImageCacheBackend> {
  const mod = await import('@capacitor/filesystem');
  const Filesystem = mod.Filesystem;
  const Directory = mod.Directory;
  const Encoding = mod.Encoding;
  const directory = Directory.Cache;

  const toB64 = (bytes: Uint8Array): string => {
    let s = '';
    for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  };
  const fromB64 = (b64: string): Uint8Array => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const ensureDir = async (): Promise<void> => {
    try {
      await Filesystem.mkdir({ path: DIR, directory, recursive: true });
    } catch {
      // already exists
    }
  };

  return {
    async read(key) {
      try {
        const res = await Filesystem.readFile({ path: `${DIR}/${safeKey(key)}`, directory });
        return fromB64(res.data as string);
      } catch {
        return null;
      }
    },
    async write(key, bytes) {
      await ensureDir();
      await Filesystem.writeFile({ path: `${DIR}/${safeKey(key)}`, data: toB64(bytes), directory });
    },
    async remove(key) {
      try {
        await Filesystem.deleteFile({ path: `${DIR}/${safeKey(key)}`, directory });
      } catch {
        // already gone
      }
    },
    async loadIndex() {
      try {
        const res = await Filesystem.readFile({ path: INDEX_FILE, directory, encoding: Encoding.UTF8 });
        return JSON.parse(res.data as string) as ImageCacheIndexEntry[];
      } catch {
        return [];
      }
    },
    async saveIndex(entries) {
      await ensureDir();
      await Filesystem.writeFile({
        path: INDEX_FILE,
        data: JSON.stringify(entries),
        directory,
        encoding: Encoding.UTF8,
      });
    },
    async clearAll() {
      try {
        await Filesystem.rmdir({ path: DIR, directory, recursive: true });
      } catch {
        // already gone
      }
    },
  };
}
