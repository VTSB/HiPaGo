/**
 * AndroidPublicDownloadStore — DownloadStore adapter for Android public
 * external storage (Downloads/HiPaGo/<id> <title>/).
 *
 * Backed by PublicLibraryPlugin (raw java.io.File ops on absolute paths).
 * The base directory and folder naming are resolved by base-path-resolver.ts.
 *
 * Folder resolution prefers an exact DB folderName when the caller supplies
 * one. Legacy galleryId prefix scan remains as a fallback only for callers that
 * do not have a persisted folderName.
 *
 * NOTE (deviation from prompt): manifest galleryId validation is intentionally
 * NOT used for folder resolution. The 0000.json manifest is a flat JSON array
 * of extension strings with no galleryId field; parsing it for id-matching
 * would add complexity without benefit. Prefix scan is not authoritative when a
 * DB row carries folderName: exact lookup avoids stale old folders with the same
 * galleryId prefix.
 */

import type { DownloadStore, DownloadStoreLookupOptions } from '../download-store';
import { imageFileName, DownloadCancelledError } from '../download-store';
import {
  galleryFolderName as resolverFolderName,
  ensureLibraryDir,
  resolveLibraryDir,
} from '../base-path-resolver';
import { PublicLibrary, ensureDownloadTree } from '@/lib/plugins/publicLibrary';
import { useSettingsStore } from '@/lib/store/settings';

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

  // ── Readiness (SAF folder pick) ──────────────────────────────────────────────

  /**
   * Ensure a download folder is selected. Prompts the SAF picker if none is set
   * yet (or the previous grant was lost). Mirrors the chosen folder into the
   * settings store for the UI.
   *
   * Throws to abort the download:
   *  - {@link DownloadCancelledError} when the user backs out of the picker —
   *    the caller treats this like an AbortError (silent, no failure recorded).
   *  - a plain Error carrying the real native reason on a genuine failure —
   *    the caller surfaces and records it.
   */
  async ensureReady(): Promise<void> {
    const currentTree = await PublicLibrary.getTree().catch(() => ({ valid: false }));
    const selectingTree = !currentTree.valid;
    let backup: typeof import('../public-backup') | null = null;

    try {
      if (selectingTree) {
        backup = await import('../public-backup');
        await backup.preparePublicBackupForTreeSelection();
      }

      const res = await ensureDownloadTree();
      if (!res.ok) {
        if (res.reason === 'cancelled') throw new DownloadCancelledError();
        throw new Error(`download folder unavailable: ${res.message}`);
      }
      useSettingsStore.getState().setDownloadTree(res.treeUri ?? null, res.displayName ?? null);

      if (selectingTree) {
        backup ??= await import('../public-backup');
        await backup.activatePublicBackupForSelectedTree();
      }
    } catch (error) {
      if (selectingTree) backup?.resumePublicBackupAfterTreeSelection();
      throw error;
    }
  }

  // ── Folder resolution ──────────────────────────────────────────────────────

  private isSafeFolderName(folderName: string): boolean {
    return (
      folderName.length > 0 &&
      !folderName.includes('/') &&
      !folderName.includes('\\') &&
      !folderName.includes('\0') &&
      folderName !== '.' &&
      folderName !== '..'
    );
  }

  /**
   * Resolve the gallery folder name for a given galleryId.
   *
   * 1. Explicit folderName option → exact directory lookup only.
   * 2. Cache hit → return immediately.
   * 3. Cache miss → readdir(libraryDir), find the entry whose name equals
   *    String(id) or starts with String(id)+' '.
   * 4. Not found → return null (caller decides whether to create a bare folder).
   */
  private async resolveFolder(
    galleryId: number,
    options?: DownloadStoreLookupOptions,
  ): Promise<string | null> {
    const preferred = options?.folderName?.trim();
    if (preferred) {
      if (!this.isSafeFolderName(preferred)) return null;
      const libDir = await resolveLibraryDir();
      const { exists } = await PublicLibrary.stat({ path: `${libDir}/${preferred}` });
      if (exists) {
        this.folderCache.set(galleryId, preferred);
        return preferred;
      }
      this.folderCache.delete(galleryId);
      return null;
    }

    const cached = this.folderCache.get(galleryId);
    if (cached !== undefined) return cached;

    const libDir = await resolveLibraryDir();
    const { exists } = await PublicLibrary.stat({ path: libDir });
    if (!exists) return null;
    const { files } = await PublicLibrary.readdir({ path: libDir });
    const idStr = String(galleryId);
    for (const entry of files) {
      const n = entry.name;
      if (n === idStr || n.startsWith(idStr + ' ')) {
        this.folderCache.set(galleryId, n);
        return n;
      }
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
    options?: DownloadStoreLookupOptions,
  ): Promise<void> {
    const libDir = await ensureLibraryDir();
    let folder = await this.resolveFolder(galleryId, options);
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
    options?: DownloadStoreLookupOptions,
  ): Promise<number> {
    const libDir = await ensureLibraryDir();
    let folder = await this.resolveFolder(galleryId, options);
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
    options?: DownloadStoreLookupOptions,
  ): Promise<Uint8Array | null> {
    const folder = await this.resolveFolder(galleryId, options);
    if (!folder) return null;
    const libDir = await resolveLibraryDir();
    const filePath = `${libDir}/${folder}/${imageFileName(index, ext)}`;
    const { exists } = await PublicLibrary.exists({ path: filePath });
    if (!exists) return null;
    const { dataBase64 } = await PublicLibrary.readFile({ path: filePath });
    return this.fromBase64(dataBase64);
  }

  // ── imageExists ──────────────────────────────────────────────────────────────

  async imageExists(
    galleryId: number,
    index: number,
    ext: string,
    options?: DownloadStoreLookupOptions,
  ): Promise<boolean> {
    const folder = await this.resolveFolder(galleryId, options);
    if (!folder) return false;
    const libDir = await resolveLibraryDir();
    const filePath = `${libDir}/${folder}/${imageFileName(index, ext)}`;
    try {
      // stat reports existence + size in one call; a present file with size 0
      // is a torn write and is reported as missing.
      const { exists, size } = await PublicLibrary.stat({ path: filePath });
      return exists && (size ?? 0) > 0;
    } catch {
      return false;
    }
  }

  async allImagesExist(
    galleryId: number,
    extensions: readonly string[],
    options?: DownloadStoreLookupOptions,
  ): Promise<boolean> {
    if (extensions.length === 0) return false;
    const folder = await this.resolveFolder(galleryId, options);
    if (!folder) return false;
    const libDir = await resolveLibraryDir();
    try {
      const { files } = await PublicLibrary.readdir({ path: `${libDir}/${folder}` });
      const nonEmptyFiles = new Set(
        files.filter((entry) => entry.size > 0).map((entry) => entry.name),
      );
      return extensions.every((ext, index) => nonEmptyFiles.has(imageFileName(index, ext)));
    } catch {
      return false;
    }
  }

  async imageSize(
    galleryId: number,
    index: number,
    ext: string,
    options?: DownloadStoreLookupOptions,
  ): Promise<number | null> {
    const folder = await this.resolveFolder(galleryId, options);
    if (!folder) return null;
    const libDir = await resolveLibraryDir();
    const filePath = `${libDir}/${folder}/${imageFileName(index, ext)}`;
    const { exists, size } = await PublicLibrary.stat({ path: filePath });
    return exists && (size ?? 0) > 0 ? (size ?? 0) : null;
  }

  // ── coverUrl ──────────────────────────────────────────────────────────────

  async coverUrl(galleryId: number, options?: DownloadStoreLookupOptions): Promise<string | null> {
    const folder = await this.resolveFolder(galleryId, options);
    if (!folder) return null;
    const libDir = await resolveLibraryDir();
    try {
      const { files } = await PublicLibrary.readdir({ path: `${libDir}/${folder}` });
      const first = files
        .map((f) => f.name)
        .filter((n) => /^0001\./.test(n))
        .sort()[0];
      if (!first) return null;
      // SAF documents are content:// URIs, which do NOT load in the WebView via
      // convertFileSrc. Read the single cover image and hand back a data URL.
      // It is one small thumbnail per gallery, so the JS-heap cost is fine.
      const { dataBase64 } = await PublicLibrary.readFile({
        path: `${libDir}/${folder}/${first}`,
      });
      const ext = first.slice(first.lastIndexOf('.') + 1).toLowerCase();
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      return `data:image/${mime};base64,${dataBase64}`;
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

  async listGalleryFolders(): Promise<{ galleryId: number; folderName: string; title: string }[]> {
    const libDir = await resolveLibraryDir();
    const { exists } = await PublicLibrary.stat({ path: libDir });
    if (!exists) return [];
    const { files } = await PublicLibrary.readdir({ path: libDir });
    const folders: { galleryId: number; folderName: string; title: string }[] = [];
    for (const entry of files) {
      const name = entry.name;
      if (name === '.nomedia') continue;
      const match = /^(\d+)(?:\s+(.*))?$/.exec(name);
      if (!match) continue;
      const galleryId = Number(match[1]);
      if (!Number.isSafeInteger(galleryId) || galleryId <= 0) continue;
      const title = match[2]?.trim() || `Gallery ${galleryId}`;
      folders.push({ galleryId, folderName: name, title });
      this.folderCache.set(galleryId, name);
    }
    return folders;
  }

  // ── gallerySize ────────────────────────────────────────────────────────────

  async gallerySize(galleryId: number, options?: DownloadStoreLookupOptions): Promise<number> {
    const folder = await this.resolveFolder(galleryId, options);
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

  /**
   * Resolve every app-owned folder for destructive operations without collapsing native I/O
   * failures into "not found". Read paths are intentionally best-effort, but a
   * delete caller must distinguish absent folders from a revoked permission
   * or provider failure so it does not drop the DB row while files remain.
   */
  private async resolveFoldersForDelete(
    galleryId: number,
    options?: DownloadStoreLookupOptions,
  ): Promise<string[]> {
    const libDir = await resolveLibraryDir();
    const preferred = options?.folderName?.trim();
    if (preferred) {
      if (!this.isSafeFolderName(preferred)) {
        throw new Error(`Unsafe download folder name: ${preferred}`);
      }
    }

    // A missing library root means the gallery is already absent. Stat/readdir
    // rejection is a real storage failure and deliberately propagates.
    const { exists: libraryExists } = await PublicLibrary.stat({ path: libDir });
    if (!libraryExists) return [];

    const { files } = await PublicLibrary.readdir({ path: libDir });
    const idStr = String(galleryId);
    const matches = files
      .map((entry) => entry.name)
      .filter((name) => name === idStr || name.startsWith(idStr + ' '));
    if (preferred && matches.includes(preferred)) {
      // Delete stale aliases first and the DB-referenced preferred folder last,
      // so a mid-sweep failure on an alias leaves the preferred folder (and the
      // still-readable gallery) intact instead of orphaning the DB row.
      return [...matches.filter((name) => name !== preferred), preferred];
    }
    return matches;
  }

  async deleteGallery(galleryId: number, options?: DownloadStoreLookupOptions): Promise<void> {
    const folders = await this.resolveFoldersForDelete(galleryId, options);
    if (folders.length === 0) return;
    const libDir = await resolveLibraryDir();
    for (const folder of folders) {
      const path = `${libDir}/${folder}`;
      await PublicLibrary.deleteDir({ path });

      // Verify the provider actually removed the tree. Older native builds ignored
      // DocumentFile.delete() returning false, and providers can fail silently.
      const { exists } = await PublicLibrary.stat({ path });
      if (exists) {
        throw new Error(`Failed to delete download folder: ${folder}`);
      }
    }
    this.folderCache.delete(galleryId);
  }
}
