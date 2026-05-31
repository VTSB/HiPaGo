/**
 * Tauri ImageCacheBackend — blobs in the OS app CACHE directory
 * (`BaseDirectory.AppCache`), NOT the persistent `AppData` used by downloads.
 * Layout: <AppCache>/image-cache/<safeKey>, index at .../image-cache/index.json
 */
import type { ImageCacheBackend, ImageCacheIndexEntry } from '../image-cache-store';

const DIR = 'image-cache';
const INDEX_FILE = `${DIR}/index.json`;

function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

export async function createTauriImageCacheBackend(): Promise<ImageCacheBackend> {
  // Variable-indirection import so the bundler does not statically resolve
  // @tauri-apps/plugin-fs in web/Capacitor builds (same pattern as the Tauri
  // download adapter).
  const pkg = '@tauri-apps/plugin-fs';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fs: any = await import(/* webpackIgnore: true */ pkg);
  const baseDir = fs.BaseDirectory.AppCache;

  const ensureDir = async (): Promise<void> => {
    try {
      await fs.mkdir(DIR, { baseDir, recursive: true });
    } catch {
      // already exists
    }
  };

  return {
    async read(key) {
      try {
        return (await fs.readFile(`${DIR}/${safeKey(key)}`, { baseDir })) as Uint8Array;
      } catch {
        return null;
      }
    },
    async write(key, bytes) {
      await ensureDir();
      await fs.writeFile(`${DIR}/${safeKey(key)}`, bytes, { baseDir });
    },
    async remove(key) {
      try {
        await fs.remove(`${DIR}/${safeKey(key)}`, { baseDir });
      } catch {
        // already gone
      }
    },
    async loadIndex() {
      try {
        const text = (await fs.readTextFile(INDEX_FILE, { baseDir })) as string;
        return JSON.parse(text) as ImageCacheIndexEntry[];
      } catch {
        return [];
      }
    },
    async saveIndex(entries) {
      await ensureDir();
      await fs.writeTextFile(INDEX_FILE, JSON.stringify(entries), { baseDir });
    },
    async clearAll() {
      try {
        await fs.remove(DIR, { baseDir, recursive: true });
      } catch {
        // already gone
      }
    },
  };
}
