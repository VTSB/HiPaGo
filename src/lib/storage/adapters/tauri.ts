/**
 * Tauri DownloadStore adapter.
 *
 * Stores gallery images under the app's data directory using direct
 * tauri-plugin-fs invoke commands. Avoid importing @tauri-apps/plugin-fs here:
 * in static-export/Tauri bundles the JS binding can be rewritten through
 * browser aliases, which previously broke native-only adapters at runtime.
 * Layout: <AppData>/downloads/<galleryId>/<filename>
 */

import type { DownloadStore } from '../download-store';
import { imageFileName, galleryFolderName } from '../download-store';

const DOWNLOADS_DIR = 'downloads';

type FsEntry = {
  name: string;
  isDirectory?: boolean;
  children?: unknown;
};

export class TauriDownloadStore implements DownloadStore {
  private baseDir: unknown;

  private constructor(baseDir: unknown) {
    this.baseDir = baseDir;
  }

  static async create(): Promise<TauriDownloadStore> {
    const { BaseDirectory } = await import('@tauri-apps/api/path');
    return new TauriDownloadStore(BaseDirectory.AppData);
  }

  private galleryPath(galleryId: number): string {
    return `${DOWNLOADS_DIR}/${galleryFolderName(galleryId)}`;
  }

  private imagePath(galleryId: number, index: number, ext: string): string {
    return `${this.galleryPath(galleryId)}/${imageFileName(index, ext)}`;
  }

  private async mkdir(path: string): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('plugin:fs|mkdir', {
      path,
      options: { baseDir: this.baseDir, recursive: true },
    });
  }

  private async stat(path: string): Promise<{ size?: number }> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<{ size?: number }>('plugin:fs|stat', {
      path,
      options: { baseDir: this.baseDir },
    });
  }

  private async readDir(path: string): Promise<FsEntry[]> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<FsEntry[]>('plugin:fs|read_dir', {
      path,
      options: { baseDir: this.baseDir },
    });
  }

  async putImage(galleryId: number, index: number, bytes: Uint8Array, ext: string): Promise<void> {
    await this.mkdir(this.galleryPath(galleryId));
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('plugin:fs|write_file', bytes, {
      headers: {
        path: encodeURIComponent(this.imagePath(galleryId, index, ext)),
        options: JSON.stringify({ baseDir: this.baseDir }),
      },
    });
  }

  async putImageFromFile(
    galleryId: number,
    index: number,
    srcPath: string,
    ext: string,
  ): Promise<number> {
    await this.mkdir(this.galleryPath(galleryId));
    const to = this.imagePath(galleryId, index, ext);
    // Native file→file copy: `srcPath` is an absolute fs path (image cache),
    // `to` is relative to AppData. No image bytes pass through the JS heap.
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('plugin:fs|copy_file', {
      fromPath: srcPath,
      toPath: to,
      options: { toPathBaseDir: this.baseDir },
    });
    const stat = await this.stat(to);
    return (stat?.size as number) ?? 0;
  }

  async getImage(galleryId: number, index: number, ext: string): Promise<Uint8Array | null> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const data = await invoke<unknown>('plugin:fs|read_file', {
        path: this.imagePath(galleryId, index, ext),
        options: { baseDir: this.baseDir },
      });
      if (data instanceof Uint8Array) return data;
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      return Uint8Array.from(data as number[]);
    } catch {
      return null;
    }
  }

  async imageExists(galleryId: number, index: number, ext: string): Promise<boolean> {
    try {
      // plugin:fs|stat throws if the path does not exist; a present file with
      // size 0 is a torn write and is reported as missing.
      const st = await this.stat(this.imagePath(galleryId, index, ext));
      return (st?.size ?? 0) > 0;
    } catch {
      return false;
    }
  }

  async imageUrl(galleryId: number, index: number, ext: string): Promise<string | null> {
    try {
      if (!(await this.imageExists(galleryId, index, ext))) return null;
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const { appDataDir, join } = await import('@tauri-apps/api/path');
      const abs = await join(await appDataDir(), this.imagePath(galleryId, index, ext));
      return convertFileSrc(abs);
    } catch {
      return null;
    }
  }

  async coverUrl(galleryId: number): Promise<string | null> {
    try {
      const dir = this.galleryPath(galleryId);
      const entries = await this.readDir(dir);
      // First page is "0001.<ext>" (imageFileName(0, ext)).
      const first = entries
        .map((e) => e.name)
        .filter((n: string) => /^0001\./.test(n))
        .sort()[0];
      if (!first) return null;
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const { appDataDir, join } = await import('@tauri-apps/api/path');
      const abs = await join(await appDataDir(), dir, first);
      return convertFileSrc(abs);
    } catch {
      return null;
    }
  }

  async listGalleries(): Promise<number[]> {
    try {
      const entries = await this.readDir(DOWNLOADS_DIR);
      const ids: number[] = [];
      for (const entry of entries) {
        if (entry.isDirectory || entry.children !== undefined) {
          const id = parseInt(entry.name, 10);
          if (!isNaN(id)) ids.push(id);
        }
      }
      return ids;
    } catch {
      return [];
    }
  }

  async deleteGallery(galleryId: number): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('plugin:fs|remove', {
        path: this.galleryPath(galleryId),
        options: { baseDir: this.baseDir, recursive: true },
      });
    } catch {
      // Already gone — treat as success.
    }
  }

  async gallerySize(galleryId: number): Promise<number> {
    try {
      const entries = await this.readDir(this.galleryPath(galleryId));
      let total = 0;
      for (const entry of entries) {
        if (!entry.isDirectory && entry.children === undefined) {
          try {
            const stat = await this.stat(`${this.galleryPath(galleryId)}/${entry.name}`);
            total += stat.size ?? 0;
          } catch {
            // Skip unreadable entries.
          }
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
    for (const id of ids) total += await this.gallerySize(id);
    return total;
  }
}
