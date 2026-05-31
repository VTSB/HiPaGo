/**
 * Capacitor ImageCacheBackend — image files in the OS CACHE directory
 * (`Directory.Cache`), NOT the persistent `Directory.Data` used by downloads.
 * Layout: <Cache>/image-cache/<safeKey>, index at <Cache>/image-cache/index.json
 *
 * Downloads stream URL→file natively via `Bypass.downloadToFile` (one chunk at a
 * time, no bytes in JS); serving returns `Capacitor.convertFileSrc(fileUri)` so
 * the WebView streams the image straight from disk.
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
  const { Capacitor } = await import('@capacitor/core');
  const { Bypass } = await import('@/lib/plugins/bypass');
  const Filesystem = mod.Filesystem;
  const Directory = mod.Directory;
  const Encoding = mod.Encoding;
  const directory = Directory.Cache;

  const ensureDir = async (): Promise<void> => {
    try {
      await Filesystem.mkdir({ path: DIR, directory, recursive: true });
    } catch {
      // already exists
    }
  };

  /** The `file://` URI of a key's blob (used both for the native path and convertFileSrc). */
  const fileUri = async (key: string): Promise<string> => {
    const { uri } = await Filesystem.getUri({ path: `${DIR}/${safeKey(key)}`, directory });
    return uri;
  };

  return {
    async statSize(key) {
      try {
        const st = await Filesystem.stat({ path: `${DIR}/${safeKey(key)}`, directory });
        return st.size;
      } catch {
        return null;
      }
    },
    async download(key, url, headers) {
      await ensureDir();
      const uri = await fileUri(key);
      // Bypass writes to a real filesystem path; strip the file:// scheme.
      const path = uri.replace(/^file:\/\//, '');
      const { size } = await Bypass.downloadToFile({ url, headers, path });
      return size;
    },
    async fileUrl(key) {
      return Capacitor.convertFileSrc(await fileUri(key));
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
