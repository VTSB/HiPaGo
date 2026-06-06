/**
 * Tauri ImageCacheBackend — image files in the OS app CACHE directory
 * (`BaseDirectory.AppCache`), NOT the persistent `AppData` used by downloads.
 * Layout: <AppCache>/image-cache/<safeKey>, index at .../image-cache/index.json
 *
 * Downloads stream URL→file natively via the `bypass_download_to_file` command
 * (one chunk at a time, no bytes in JS); serving returns `convertFileSrc(path)`
 * (asset protocol) so the WebView streams the image straight from disk.
 */
import type { ImageCacheBackend, ImageCacheIndexEntry } from '../image-cache-store';

const DIR = 'image-cache';
const INDEX_FILE = `${DIR}/index.json`;

function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

export async function createTauriImageCacheBackend(): Promise<ImageCacheBackend> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fs: any = await import('@tauri-apps/plugin-fs');
  const { invoke, convertFileSrc } = await import('@tauri-apps/api/core');
  const { appCacheDir, join } = await import('@tauri-apps/api/path');
  const baseDir = fs.BaseDirectory.AppCache;
  const appCache = await appCacheDir();

  const absPath = (key: string): Promise<string> => join(appCache, DIR, safeKey(key));

  const ensureDir = async (): Promise<void> => {
    try {
      await fs.mkdir(DIR, { baseDir, recursive: true });
    } catch {
      // already exists
    }
  };

  return {
    async statSize(key) {
      try {
        const info = await fs.stat(`${DIR}/${safeKey(key)}`, { baseDir });
        return info.size as number;
      } catch {
        return null;
      }
    },
    async download(key, url, headers) {
      await ensureDir();
      const destPath = await absPath(key);
      const size = await invoke<number>('bypass_download_to_file', { url, headers, destPath });
      return size;
    },
    async fileUrl(key) {
      return convertFileSrc(await absPath(key));
    },
    async filePath(key) {
      // Absolute fs path for a native fs.copyFile (download reuse).
      return absPath(key);
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
