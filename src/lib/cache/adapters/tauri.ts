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
  const { invoke, convertFileSrc } = await import('@tauri-apps/api/core');
  const { BaseDirectory, appCacheDir, join } = await import('@tauri-apps/api/path');
  const baseDir = BaseDirectory.AppCache;
  const appCache = await appCacheDir();

  const absPath = (key: string): Promise<string> => join(appCache, DIR, safeKey(key));
  const relPath = (key: string): string => `${DIR}/${safeKey(key)}`;

  const ensureDir = async (): Promise<void> => {
    try {
      await invoke('plugin:fs|mkdir', {
        path: DIR,
        options: { baseDir, recursive: true },
      });
    } catch {
      // already exists
    }
  };

  return {
    async statSize(key) {
      try {
        const info = await invoke<{ size: number }>('plugin:fs|stat', {
          path: relPath(key),
          options: { baseDir },
        });
        return info.size as number;
      } catch {
        return null;
      }
    },
    async download(key, url, headers) {
      await ensureDir();
      const cacheKey = safeKey(key);
      const size = await invoke<number>('bypass_download_to_file', { url, headers, cacheKey });
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
        await invoke('plugin:fs|remove', {
          path: relPath(key),
          options: { baseDir },
        });
      } catch {
        // already gone
      }
    },
    async loadIndex() {
      try {
        const data = await invoke<unknown>('plugin:fs|read_text_file', {
          path: INDEX_FILE,
          options: { baseDir },
        });
        const text =
          typeof data === 'string'
            ? data
            : new TextDecoder().decode(
                data instanceof ArrayBuffer
                  ? new Uint8Array(data)
                  : Uint8Array.from(data as number[]),
              );
        return JSON.parse(text) as ImageCacheIndexEntry[];
      } catch {
        return [];
      }
    },
    async saveIndex(entries) {
      await ensureDir();
      await invoke('plugin:fs|write_text_file', new TextEncoder().encode(JSON.stringify(entries)), {
        headers: {
          path: encodeURIComponent(INDEX_FILE),
          options: JSON.stringify({ baseDir }),
        },
      });
    },
    async clearAll() {
      try {
        await invoke('plugin:fs|remove', {
          path: DIR,
          options: { baseDir, recursive: true },
        });
      } catch {
        // already gone
      }
    },
  };
}
