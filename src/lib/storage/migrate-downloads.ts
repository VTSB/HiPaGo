/**
 * migrate-downloads.ts
 *
 * One-time Data→public migration + startup reconciliation for Android.
 *
 * Migration:
 *   For each DB download row where migratedAt is null:
 *   1. Confirm the old Directory.Data folder exists (listGalleries on old store).
 *   2. Read the old manifest (0000.json) to discover page extensions.
 *   3. ensureGallery on the new store (creates "<id> <title>" folder).
 *   4. Copy manifest + each page to the new store.
 *   5. Validate the new folder has the manifest (getImage non-null).
 *   6. markDownloadMigrated + setDownloadFolderName.
 *   7. deleteGallery on the old store.
 *
 * Idempotent: if new folder already has the manifest, skip copy.
 * Resumable: per-row migratedAt watermark — crash resumes at next null row.
 *
 * Reconciliation (reconcileLibrary):
 *   For each DB row that has already been migrated (migratedAt != null), if the
 *   new store has no manifest for that gallery (folder deleted/renamed by user),
 *   prune the dead DB row via deleteDownload.
 *   Rows with migratedAt == null are skipped — they live in the old store and
 *   their absence from the new store is expected.
 */

import { isAndroid } from '@/lib/utils/platform';
import { listDownloads, markDownloadMigrated, setDownloadFolderName, deleteDownload } from '@/lib/db/download';
import { galleryFolderName } from '@/lib/storage/base-path-resolver';
import type { DownloadStore } from '@/lib/storage/download-store';

// ── Internal helpers ──────────────────────────────────────────────────────────

/** ISO-8601 timestamp for "now". */
function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Decode a manifest JSON byte array to a string extension array.
 * The 0000.json manifest is a flat JSON array of extension strings, one per page.
 * Returns null if the manifest is missing or malformed.
 */
function decodeManifest(bytes: Uint8Array): string[] | null {
  try {
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as string[];
    return null;
  } catch {
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Migrate all un-migrated DB download rows from Directory.Data (old
 * CapacitorDownloadStore) to Android public storage (AndroidPublicDownloadStore).
 *
 * Guard: no-op on non-Android platforms.
 * Returns { migrated, reconciled } counts.
 */
export async function migrateDownloadsToPublic(): Promise<{ migrated: number; reconciled: number }> {
  if (!isAndroid()) return { migrated: 0, reconciled: 0 };

  // Lazy-import adapters to avoid loading native modules on non-Android paths.
  const { CapacitorDownloadStore } = await import('./adapters/capacitor');
  const { AndroidPublicDownloadStore } = await import('./adapters/android-public');

  const oldStore: DownloadStore = await CapacitorDownloadStore.create();
  const newStore: DownloadStore = AndroidPublicDownloadStore.create();

  const rows = await listDownloads();
  let migrated = 0;

  for (const row of rows) {
    // Skip rows that are already migrated.
    if (row.migratedAt != null) continue;

    const { galleryId, title } = row;

    try {
      // ── Check if old folder exists ──────────────────────────────────────────
      const oldIds = await oldStore.listGalleries();
      if (!oldIds.includes(galleryId)) {
        // Old folder not present — nothing to copy; row stays with null migratedAt
        // so reconciliation can decide what to do later.
        continue;
      }

      // ── Read old manifest ────────────────────────────────────────────────────
      const manifestBytes = await oldStore.getImage(galleryId, -1, 'json');
      if (!manifestBytes) {
        // No manifest in old store — cannot determine page extensions; skip this row.
        continue;
      }
      const exts = decodeManifest(manifestBytes);
      if (!exts) {
        // Malformed manifest; skip.
        continue;
      }

      // ── Check if new folder already has the manifest (idempotent) ─────────
      const folderName = galleryFolderName(galleryId, title);
      await newStore.ensureGallery!(galleryId, title);
      const existingManifest = await newStore.getImage(galleryId, -1, 'json');
      if (existingManifest != null) {
        // Already migrated — just update DB to mark it and move on.
        await markDownloadMigrated(galleryId, folderName, nowISO());
        await setDownloadFolderName(galleryId, folderName);
        migrated++;
        continue;
      }

      // ── Copy manifest ─────────────────────────────────────────────────────
      await newStore.putImage(galleryId, -1, manifestBytes, 'json');

      // ── Copy each page ────────────────────────────────────────────────────
      for (let i = 0; i < exts.length; i++) {
        const ext = exts[i];
        const pageBytes = await oldStore.getImage(galleryId, i, ext);
        if (pageBytes == null) {
          // Missing page — skip (partial download preserved in new store as-is).
          continue;
        }
        await newStore.putImage(galleryId, i, pageBytes, ext);
      }

      // ── Validate new folder has the manifest ──────────────────────────────
      const newManifest = await newStore.getImage(galleryId, -1, 'json');
      if (!newManifest) {
        // Validation failed — do not delete old folder; leave for next run.
        continue;
      }

      // ── Update DB ─────────────────────────────────────────────────────────
      await markDownloadMigrated(galleryId, folderName, nowISO());
      await setDownloadFolderName(galleryId, folderName);

      // ── Delete old folder only after validation ───────────────────────────
      await oldStore.deleteGallery(galleryId);

      migrated++;
    } catch {
      // Per-row error: log and continue so subsequent rows are not blocked.
      // This is intentional — crash-resumable via migratedAt watermark.
    }
  }

  // Run reconciliation after migration and return combined counts.
  const reconciled = await reconcileLibrary(newStore);

  return { migrated, reconciled };
}

/**
 * Reconcile the DB against the new public store.
 *
 * Only checks rows where migratedAt != null (rows known to be in public storage).
 * Rows with migratedAt == null live in the old Directory.Data store; their
 * absence from the new store is expected and they are never pruned here.
 *
 * For each checked row, if the new store has no manifest (folder deleted/renamed
 * by the user), delete the DB row (prune the dead entry).
 *
 * Can be called standalone (e.g. after a permission grant recheck).
 * Returns the count of pruned rows.
 */
export async function reconcileLibrary(newStore?: DownloadStore): Promise<number> {
  if (!isAndroid()) return 0;

  let store = newStore;
  if (!store) {
    const { AndroidPublicDownloadStore } = await import('./adapters/android-public');
    store = AndroidPublicDownloadStore.create();
  }

  const rows = await listDownloads();
  let pruned = 0;

  for (const row of rows) {
    // Skip un-migrated rows — they are not expected to be in the new store yet.
    if (row.migratedAt == null) continue;

    const { galleryId } = row;
    try {
      const manifest = await store.getImage(galleryId, -1, 'json');
      if (manifest == null) {
        await deleteDownload(galleryId);
        pruned++;
      }
    } catch {
      // Best-effort; do not prune on errors — conservative.
    }
  }

  return pruned;
}
