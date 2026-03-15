import { ensureDb, isDbInitialized, persistDb, withTransaction } from './adapter';
import type { GalleryBlock, GalleryFile } from '@/lib/utils/types';
import { GalleryBlockType } from '@/lib/utils/types';
import type { TagType } from '@/lib/utils/types';
import { saveGalleryRelated, getGalleryRelated } from './gallery-relate';
import { saveGalleryTags, getGalleryTags } from './gallery-tag';
import { patchNewTagCounts } from './patch-tag-counts';

export async function saveGalleryBlock(block: GalleryBlock): Promise<void> {
  const db = await ensureDb();

  await withTransaction(async () => {
    await db.execute(
      `INSERT OR REPLACE INTO gallery (id, type, title, date, thumbnail, url, language, mediaType, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        block.id,
        block.type,
        block.title,
        block.date.toISOString(),
        block.thumbnail,
        '',
        block.language || '',
        block.mediaType || '',
        new Date().toISOString(),
      ],
    );

    await saveGalleryRelated(block.id, block.related);
    await saveGalleryTags(block.id, block.tags);
  });

  // Fire-and-forget: patch count=0 tags with real counts from tagindex API.
  // Runs after the transaction so it doesn't block or affect the save.
  const flatTags: Array<{ type: TagType; name: string }> = [];
  for (const [typeStr, names] of Object.entries(block.tags)) {
    if (!names) continue;
    for (const name of names) {
      flatTags.push({ type: typeStr as TagType, name });
    }
  }
  if (flatTags.length > 0) {
    patchNewTagCounts(flatTags).catch(() => {
      // Swallow errors — tag count patching is best-effort
    });
  }
}

export async function getGalleryBlock(id: number): Promise<GalleryBlock | null> {
  const db = await ensureDb();
  const rows = await db.query<{
    id: number;
    type: number;
    title: string;
    date: string;
    thumbnail: string;
    language: string;
    mediaType: string;
    updatedAt: string;
  }>('SELECT id, type, title, date, thumbnail, language, mediaType, updatedAt FROM gallery WHERE id = ? AND type > 0', [id]);

  if (rows.length === 0) return null;
  const row = rows[0];

  const tags = await getGalleryTags(id);
  const related = await getGalleryRelated(id);

  return {
    id: row.id,
    title: row.title,
    date: new Date(row.date),
    tags,
    thumbnail: row.thumbnail,
    related,
    language: row.language || '',
    mediaType: row.mediaType || '',
    type: Object.values(GalleryBlockType).includes(row.type) ? (row.type as GalleryBlockType) : GalleryBlockType.FAILED,
    updatedAt: new Date(row.updatedAt),
  };
}

export async function addFavorite(galleryId: number): Promise<void> {
  const db = await ensureDb();
  await db.execute(
    'INSERT OR IGNORE INTO favorites (galleryId, addedAt) VALUES (?, ?)',
    [galleryId, new Date().toISOString()],
  );
  await persistDb();
}

export async function removeFavorite(galleryId: number): Promise<void> {
  const db = await ensureDb();
  await db.execute('DELETE FROM favorites WHERE galleryId = ?', [galleryId]);
  await persistDb();
}

export async function isFavorite(galleryId: number): Promise<boolean> {
  if (!isDbInitialized()) return false;
  const db = await ensureDb();
  const rows = await db.query<{ c: number }>(
    'SELECT COUNT(*) as c FROM favorites WHERE galleryId = ?',
    [galleryId],
  );
  return rows[0].c > 0;
}

export async function getFavoriteIds(): Promise<number[]> {
  const db = await ensureDb();
  const rows = await db.query<{ galleryId: number }>(
    'SELECT galleryId FROM favorites ORDER BY addedAt DESC',
  );
  return rows.map((r) => r.galleryId);
}

export async function recordHistory(
  galleryId: number,
  lastPage: number,
  totalPages: number,
  readerMode: string,
): Promise<void> {
  const db = await ensureDb();
  await db.execute(
    `INSERT INTO history (galleryId, lastPage, totalPages, readerMode, viewedAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(galleryId) DO UPDATE SET
       lastPage = excluded.lastPage,
       totalPages = excluded.totalPages,
       readerMode = excluded.readerMode,
       viewedAt = excluded.viewedAt`,
    [galleryId, lastPage, totalPages, readerMode, new Date().toISOString()],
  );
  await persistDb();
}

/** Record a gallery visit (detail page view). Updates viewedAt without overwriting reading progress. */
export async function recordVisit(galleryId: number): Promise<void> {
  const db = await ensureDb();
  await db.execute(
    `INSERT INTO history (galleryId, lastPage, totalPages, readerMode, viewedAt)
     VALUES (?, 0, 0, '', ?)
     ON CONFLICT(galleryId) DO UPDATE SET
       viewedAt = excluded.viewedAt`,
    [galleryId, new Date().toISOString()],
  );
  await persistDb();
}

export async function getRecentlyViewedIds(limit = 100): Promise<number[]> {
  const db = await ensureDb();
  const rows = await db.query<{ galleryId: number }>(
    'SELECT galleryId FROM history ORDER BY viewedAt DESC LIMIT ?',
    [limit],
  );
  return rows.map((r) => r.galleryId);
}

export async function getRecentlyViewedWithDates(limit = 500): Promise<Array<{ galleryId: number; viewedAt: string }>> {
  const db = await ensureDb();
  return db.query<{ galleryId: number; viewedAt: string }>(
    'SELECT galleryId, viewedAt FROM history ORDER BY viewedAt DESC LIMIT ?',
    [limit],
  );
}

export async function getReadingProgress(
  galleryId: number,
): Promise<{ lastPage: number; totalPages: number; readerMode: string } | null> {
  const db = await ensureDb();
  const rows = await db.query<{
    lastPage: number;
    totalPages: number;
    readerMode: string;
  }>('SELECT lastPage, totalPages, readerMode FROM history WHERE galleryId = ?', [galleryId]);
  return rows[0] ?? null;
}

export async function saveGalleryImages(galleryId: number, files: GalleryFile[]): Promise<void> {
  const db = await ensureDb();
  await withTransaction(async () => {
    await db.execute('DELETE FROM gallery_image WHERE galleryId = ?', [galleryId]);
    if (files.length === 0) return;
    // Batch insert in chunks of 50
    const CHUNK = 50;
    for (let i = 0; i < files.length; i += CHUNK) {
      const chunk = files.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const params = chunk.flatMap((file, j) => [
        galleryId, i + j, file.width, file.height, file.haswebp, file.hasavif, file.hasavifsmalltn, file.name, file.hash,
      ]);
      await db.execute(
        `INSERT INTO gallery_image (galleryId, pageIndex, width, height, haswebp, hasavif, hasavifsmalltn, name, hash) VALUES ${placeholders}`,
        params,
      );
    }
  });
}

export async function getGalleryImages(galleryId: number): Promise<GalleryFile[] | null> {
  const db = await ensureDb();
  const rows = await db.query<GalleryFile>(
    `SELECT width, height, haswebp, hasavif, hasavifsmalltn, name, hash
     FROM gallery_image WHERE galleryId = ? ORDER BY pageIndex ASC`,
    [galleryId],
  );
  if (rows.length === 0) return null;
  return rows;
}

export async function hasGalleryImages(galleryId: number): Promise<boolean> {
  const db = await ensureDb();
  const rows = await db.query<{ c: number }>(
    'SELECT COUNT(*) as c FROM gallery_image WHERE galleryId = ?',
    [galleryId],
  );
  return rows[0].c > 0;
}

export async function deleteGalleryImages(galleryId: number): Promise<void> {
  const db = await ensureDb();
  await db.execute('DELETE FROM gallery_image WHERE galleryId = ?', [galleryId]);
}

/** Delete gallery cache entries older than the given number of days. */
export async function cleanupStaleCache(days = 30): Promise<number> {
  if (!isDbInitialized()) return 0;
  const db = await ensureDb();

  // Remove invalid FAILED blocks unconditionally
  await db.execute('DELETE FROM gallery WHERE type = -1');
  // Clean orphaned junction rows
  await db.execute('DELETE FROM gallery_tag WHERE id NOT IN (SELECT id FROM gallery)');
  await db.execute('DELETE FROM gallery_relate WHERE id NOT IN (SELECT id FROM gallery)');

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Get stale gallery IDs (exclude favorites)
  const stale = await db.query<{ id: number }>(
    `SELECT g.id FROM gallery g
     LEFT JOIN favorites f ON g.id = f.galleryId
     WHERE g.updatedAt < ? AND f.galleryId IS NULL`,
    [cutoff],
  );
  if (stale.length === 0) return 0;

  const ids = stale.map((r) => r.id);
  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    await db.execute(`DELETE FROM gallery_image WHERE galleryId IN (${placeholders})`, chunk);
    await db.execute(`DELETE FROM gallery_tag WHERE id IN (${placeholders})`, chunk);
    await db.execute(`DELETE FROM gallery_relate WHERE id IN (${placeholders})`, chunk);
    await db.execute(`DELETE FROM gallery WHERE id IN (${placeholders})`, chunk);
  }

  return ids.length;
}
