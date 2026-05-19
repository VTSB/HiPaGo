/**
 * Capacitor DownloadStore adapter.
 *
 * Stores gallery images in the app's data directory using
 * @capacitor/filesystem.  Layout:
 *   <AppData>/downloads/<galleryId>/<filename>
 */

import type { DownloadStore } from '../download-store';
import { imageFileName, galleryFolderName } from '../download-store';

const DOWNLOADS_DIR = 'downloads';

export class CapacitorDownloadStore implements DownloadStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private Filesystem: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private Directory: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private Encoding: any;

  private constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Filesystem: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Directory: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Encoding: any,
  ) {
    this.Filesystem = Filesystem;
    this.Directory = Directory;
    this.Encoding = Encoding;
  }

  static async create(): Promise<CapacitorDownloadStore> {
    const mod = await import('@capacitor/filesystem');
    return new CapacitorDownloadStore(
      mod.Filesystem,
      mod.Directory,
      mod.Encoding,
    );
  }

  private galleryPath(galleryId: number): string {
    return `${DOWNLOADS_DIR}/${galleryFolderName(galleryId)}`;
  }

  private imagePath(galleryId: number, index: number, ext: string): string {
    return `${this.galleryPath(galleryId)}/${imageFileName(index, ext)}`;
  }

  /** Encode bytes as base64 string for Capacitor Filesystem writeFile. */
  private toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /** Decode base64 string returned by Capacitor Filesystem readFile. */
  private fromBase64(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async putImage(
    galleryId: number,
    index: number,
    bytes: Uint8Array,
    ext: string,
  ): Promise<void> {
    await this.Filesystem.mkdir({
      path: this.galleryPath(galleryId),
      directory: this.Directory.Data,
      recursive: true,
    });
    await this.Filesystem.writeFile({
      path: this.imagePath(galleryId, index, ext),
      data: this.toBase64(bytes),
      directory: this.Directory.Data,
    });
  }

  async getImage(
    galleryId: number,
    index: number,
    ext: string,
  ): Promise<Uint8Array | null> {
    try {
      const result = await this.Filesystem.readFile({
        path: this.imagePath(galleryId, index, ext),
        directory: this.Directory.Data,
      });
      return this.fromBase64(result.data as string);
    } catch {
      return null;
    }
  }

  async listGalleries(): Promise<number[]> {
    try {
      const result = await this.Filesystem.readdir({
        path: DOWNLOADS_DIR,
        directory: this.Directory.Data,
      });
      const ids: number[] = [];
      for (const entry of result.files) {
        const name = typeof entry === 'string' ? entry : entry.name;
        const id = parseInt(name, 10);
        if (!isNaN(id)) ids.push(id);
      }
      return ids;
    } catch {
      return [];
    }
  }

  async deleteGallery(galleryId: number): Promise<void> {
    try {
      await this.Filesystem.rmdir({
        path: this.galleryPath(galleryId),
        directory: this.Directory.Data,
        recursive: true,
      });
    } catch {
      // Already gone — treat as success.
    }
  }

  async gallerySize(galleryId: number): Promise<number> {
    try {
      const result = await this.Filesystem.readdir({
        path: this.galleryPath(galleryId),
        directory: this.Directory.Data,
      });
      let total = 0;
      for (const entry of result.files) {
        const name = typeof entry === 'string' ? entry : entry.name;
        try {
          const stat = await this.Filesystem.stat({
            path: `${this.galleryPath(galleryId)}/${name}`,
            directory: this.Directory.Data,
          });
          total += stat.size ?? 0;
        } catch {
          // Skip unreadable entries.
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
