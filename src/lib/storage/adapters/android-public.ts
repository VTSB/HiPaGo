/**
 * AndroidPublicDownloadStore — DownloadStore adapter for Android public
 * external storage (Downloads/HiPaGo/<id> <title>/).
 *
 * Backed by PublicLibraryPlugin (raw java.io.File ops on absolute paths).
 * The base directory and folder naming are resolved by base-path-resolver.ts.
 *
 * Folder resolution is id-prefix based (name starts with String(id)):
 *   - cache hit → immediate return
 *   - cache miss → readdir(libraryDir), find first entry whose name equals
 *     String(id) or starts with String(id)+' '
 *
 * NOTE (deviation from prompt): manifest galleryId validation is intentionally
 * NOT used for folder resolution. The 0000.json manifest is a flat JSON array
 * of extension strings with no galleryId field; parsing it for id-matching
 * would add complexity without benefit. Prefix-scan on the folder name is the
 * authoritative lookup (see PLAN.md §Architecture decision).
 */

import type { DownloadStore } from '../download-store';
import { imageFileName } from '../download-store';
import {
  galleryFolderName as resolverFolderName,
  ensureLibraryDir,
  resolveLibraryDir,
} from '../base-path-resolver';
import { PublicLibrary } from '@/lib/plugins/publicLibrary';

export class AndroidPublicDownloadStore implements DownloadStore {
  /** Cache: galleryId → resolved folder name (e.g. "12345 My Title"). */
  private folderCache = new Map<number, string>();

  private constructor() {}

  static create(): AndroidPublicDownloadStore {
    return new AndroidPublicDownloadStore();
  }

  // ── Base64 helpers ─────────────────────────────────────────────────────────

  private toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private fromBase64(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // ── Folder resolution ──────────────────────────────────────────────────────

  /**
   * Resolve the gallery folder name for a given galleryId.
   *
   * 1. Cache hit → return immediately.
   * 2. Cache miss → readdir(libraryDir), find the entry whose name equals
   *    String(id) or starts with String(id)+' '.
   * 3. Not found → return null (caller decides whether to create a bare folder).
   */
  private async resolveFolder(galleryId: number): Promise<string | null> {
    const cached = this.folderCache.get(galleryId);
    if (cached !== undefined) return cached;

    const libDir = await resolveLibraryDir();
    try {
      const { files } = await PublicLibrary.readdir({ path: libDir });
      const idStr = String(galleryId);
      for (const entry of files) {
        const n = entry.name;
        if (n === idStr || n.startsWith(idStr + ' ')) {
          this.folderCache.set(galleryId, n);
          return n;
        }
      }
    } catch {
      // Library dir doesn't exist yet or readdir failed — not found.
    }
    return null;
  }

  /**
   * Ensure the gallery folder exists and is cached. Uses the known title to
   * build the `<id> <title>` name. Creates the library dir (+ .nomedia) too.
   */
  async ensureGallery(galleryId: number, title: string): Promise<void> {
    const libDir = await ensureLibraryDir();
    const folder = resolverFolderName(galleryId, title);
    await PublicLibrary.mkdir({ path: `${libDir}/${folder}` });
    this.folderCache.set(galleryId, folder);
  }

  // ── putImage ───────────────────────────────────────────────────────────────

  async putImage(
    galleryId: number,
    index: number,
    bytes: Uint8Array,
    ext: string,
  ): Promise<void> {
    const libDir = await ensureLibraryDir();
    let folder = await this.resolveFolder(galleryId);
    if (!folder) {
      // No title available here — create a bare numeric folder as last resort.
      folder = String(galleryId);
      await PublicLibrary.mkdir({ path: `${libDir}/${folder}` });
      this.folderCache.set(galleryId, folder);
    }
    const filePath = `${libDir}/${folder}/${imageFileName(index, ext)}`;
    await PublicLibrary.writeFile({ path: filePath, dataBase64: this.toBase64(bytes) });
  }

  // ── putImageFromFile ───────────────────────────────────────────────────────

  async putImageFromFile(
    galleryId: number,
    index: number,
    srcPath: string,
    ext: string,
  ): Promise<number> {
    const libDir = await ensureLibraryDir();
    let folder = await this.resolveFolder(galleryId);
    if (!folder) {
      folder = String(galleryId);
      await PublicLibrary.mkdir({ path: `${libDir}/${folder}` });
      this.folderCache.set(galleryId, folder);
    }
    const to = `${libDir}/${folder}/${imageFileName(index, ext)}`;
    await PublicLibrary.copy({ from: srcPath, to });
    const { size } = await PublicLibrary.stat({ path: to });
    return size ?? 0;
  }

  // ── getImage ───────────────────────────────────────────────────────────────

  async getImage(
    galleryId: number,
    index: number,
    ext: string,
  ): Promise<Uint8Array | null> {
    const folder = await this.resolveFolder(galleryId);
    if (!folder) return null;
    const libDir = await resolveLibraryDir();
    const filePath = `${libDir}/${folder}/${imageFileName(index, ext)}`;
    try {
      const { exists } = await PublicLibrary.exists({ path: filePath });
      if (!exists) return null;
      const { dataBase64 } = await PublicLibrary.readFile({ path: filePath });
      return this.fromBase64(dataBase64);
    } catch {
      return null;
    }
  }

  // ── coverUrl ──────────────────────────────────────────────────────────────

  async coverUrl(galleryId: number): Promise<string | null> {
    const folder = await this.resolveFolder(galleryId);
    if (!folder) return null;
    const libDir = await resolveLibraryDir();
    try {
      const { files } = await PublicLibrary.readdir({ path: `${libDir}/${folder}` });
      const first = files
        .map((f) => f.name)
        .filter((n) => /^0001\./.test(n))
        .sort()[0];
      if (!first) return null;
      const { uri } = await PublicLibrary.getUri({ path: `${libDir}/${folder}/${first}` });
      const { Capacitor } = await import('@capacitor/core');
      return Capacitor.convertFileSrc(uri);
    } catch {
      return null;
    }
  }

  // ── listGalleries ──────────────────────────────────────────────────────────

  async listGalleries(): Promise<number[]> {
    const libDir = await resolveLibraryDir();
    try {
      const { files } = await PublicLibrary.readdir({ path: libDir });
      const ids: number[] = [];
      for (const entry of files) {
        const name = entry.name;
        if (name === '.nomedia') continue;
        const id = parseInt(name, 10);
        if (!isNaN(id)) ids.push(id);
      }
      return ids;
    } catch {
      return [];
    }
  }

  // ── gallerySize ────────────────────────────────────────────────────────────

  async gallerySize(galleryId: number): Promise<number> {
    const folder = await this.resolveFolder(galleryId);
    if (!folder) return 0;
    const libDir = await resolveLibraryDir();
    try {
      const { files } = await PublicLibrary.readdir({ path: `${libDir}/${folder}` });
      let total = 0;
      for (const entry of files) {
        total += entry.size;
      }
      return total;
    } catch {
      return 0;
    }
  }

  // ── usage ──────────────────────────────────────────────────────────────────

  async usage(): Promise<number> {
    const ids = await this.listGalleries();
    let total = 0;
    for (const id of ids) total += await this.gallerySize(id);
    return total;
  }

  // ── deleteGallery ──────────────────────────────────────────────────────────

  async deleteGallery(galleryId: number): Promise<void> {
    const folder = await this.resolveFolder(galleryId);
    if (!folder) return; // Already gone — treat as success.
    const libDir = await resolveLibraryDir();
    try {
      await PublicLibrary.deleteDir({ path: `${libDir}/${folder}` });
    } catch {
      // Already gone — treat as success.
    }
    this.folderCache.delete(galleryId);
  }
}
