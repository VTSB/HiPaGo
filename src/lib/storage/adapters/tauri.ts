/**
 * Tauri DownloadStore adapter.
 *
 * Stores gallery images under the app's data directory using
 * @tauri-apps/plugin-fs (dynamically imported at runtime — not installed as a
 * build-time dep, matching the pattern of TauriAdapter in src/lib/db/).
 * Layout: <AppData>/downloads/<galleryId>/<filename>
 */

import type { DownloadStore } from '../download-store';
import { imageFileName, galleryFolderName } from '../download-store';

const DOWNLOADS_DIR = 'downloads';

export class TauriDownloadStore implements DownloadStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private fs: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private BaseDirectory: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private constructor(fs: any, BaseDirectory: any) {
    this.fs = fs;
    this.BaseDirectory = BaseDirectory;
  }

  static async create(): Promise<TauriDownloadStore> {
    // Variable-indirection import so the bundler does not statically resolve
    // @tauri-apps/plugin-fs at build time — it is only installed in Tauri
    // builds, not in web/Capacitor. Same pattern as bypass-fetch.ts /
    // tag-fetcher.ts use for optional native modules.
    const pkg = '@tauri-apps/plugin-fs';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fs: any = await import(/* webpackIgnore: true */ pkg);
    return new TauriDownloadStore(fs, fs.BaseDirectory);
  }

  private galleryPath(galleryId: number): string {
    return `${DOWNLOADS_DIR}/${galleryFolderName(galleryId)}`;
  }

  private imagePath(galleryId: number, index: number, ext: string): string {
    return `${this.galleryPath(galleryId)}/${imageFileName(index, ext)}`;
  }

  async putImage(
    galleryId: number,
    index: number,
    bytes: Uint8Array,
    ext: string,
  ): Promise<void> {
    await this.fs.mkdir(this.galleryPath(galleryId), {
      baseDir: this.BaseDirectory.AppData,
      recursive: true,
    });
    await this.fs.writeFile(this.imagePath(galleryId, index, ext), bytes, {
      baseDir: this.BaseDirectory.AppData,
    });
  }

  async putImageFromFile(
    galleryId: number,
    index: number,
    srcPath: string,
    ext: string,
  ): Promise<number> {
    await this.fs.mkdir(this.galleryPath(galleryId), {
      baseDir: this.BaseDirectory.AppData,
      recursive: true,
    });
    const to = this.imagePath(galleryId, index, ext);
    // Native file→file copy: `srcPath` is an absolute fs path (image cache),
    // `to` is relative to AppData. No image bytes pass through the JS heap.
    await this.fs.copyFile(srcPath, to, { toPathBaseDir: this.BaseDirectory.AppData });
    const stat = await this.fs.stat(to, { baseDir: this.BaseDirectory.AppData });
    return (stat?.size as number) ?? 0;
  }

  async getImage(
    galleryId: number,
    index: number,
    ext: string,
  ): Promise<Uint8Array | null> {
    try {
      const data = await this.fs.readFile(
        this.imagePath(galleryId, index, ext),
        { baseDir: this.BaseDirectory.AppData },
      );
      return data instanceof Uint8Array ? data : new Uint8Array(data);
    } catch {
      return null;
    }
  }

  async listGalleries(): Promise<number[]> {
    try {
      const entries = await this.fs.readDir(DOWNLOADS_DIR, {
        baseDir: this.BaseDirectory.AppData,
      });
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
      await this.fs.remove(this.galleryPath(galleryId), {
        baseDir: this.BaseDirectory.AppData,
        recursive: true,
      });
    } catch {
      // Already gone — treat as success.
    }
  }

  async gallerySize(galleryId: number): Promise<number> {
    try {
      const entries = await this.fs.readDir(this.galleryPath(galleryId), {
        baseDir: this.BaseDirectory.AppData,
      });
      let total = 0;
      for (const entry of entries) {
        if (!entry.isDirectory && entry.children === undefined) {
          try {
            const stat = await this.fs.stat(
              `${this.galleryPath(galleryId)}/${entry.name}`,
              { baseDir: this.BaseDirectory.AppData },
            );
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
