import { getDb, isDbInitialized } from './adapter';
import { initializeDatabase } from './schema';
import type { GalleryBlock, GalleryFile } from '@/lib/utils/types';
import type { GalleryBlockType } from '@/lib/utils/types';
import { saveGalleryRelated, getGalleryRelated } from './gallery-relate';
import { saveGalleryTags, getGalleryTags } from './gallery-tag';

export async function saveGalleryBlock(block: GalleryBlock): Promise<void> {
  const db = getDb();

  await db.execute(
    `INSERT OR REPLACE INTO gallery (id, type, title, date, thumbnail, url, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      block.id,
      block.type,
      block.title,
      block.date.toISOString(),
      block.thumbnail,
      '',
      new Date().toISOString(),
    ],
  );

  await saveGalleryRelated(block.id, block.related);
  await saveGalleryTags(block.id, block.tags);
}

export async function getGalleryBlock(id: number): Promise<GalleryBlock | null> {
  const rows = await getDb().query<{
    id: number;
    type: number;
    title: string;
    date: string;
    thumbnail: string;
  }>('SELECT id, type, title, date, thumbnail FROM gallery WHERE id = ?', [id]);

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
    type: row.type as GalleryBlockType,
  };
}

export async function addFavorite(galleryId: number): Promise<void> {
  await getDb().execute(
    'INSERT OR IGNORE INTO favorites (galleryId, addedAt) VALUES (?, ?)',
    [galleryId, new Date().toISOString()],
  );
}

export async function removeFavorite(galleryId: number): Promise<void> {
  await getDb().execute('DELETE FROM favorites WHERE galleryId = ?', [galleryId]);
}

export async function isFavorite(galleryId: number): Promise<boolean> {
  if (!isDbInitialized()) return false;
  const rows = await getDb().query<{ c: number }>(
    'SELECT COUNT(*) as c FROM favorites WHERE galleryId = ?',
    [galleryId],
  );
  return rows[0].c > 0;
}

export async function getFavoriteIds(): Promise<number[]> {
  await initializeDatabase();
  const rows = await getDb().query<{ galleryId: number }>(
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
  if (!isDbInitialized()) return;
  await getDb().execute(
    `INSERT INTO history (galleryId, lastPage, totalPages, readerMode, viewedAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(galleryId) DO UPDATE SET
       lastPage = excluded.lastPage,
       totalPages = excluded.totalPages,
       readerMode = excluded.readerMode,
       viewedAt = excluded.viewedAt`,
    [galleryId, lastPage, totalPages, readerMode, new Date().toISOString()],
  );
}

/** Record a gallery visit (detail page view). Updates viewedAt without overwriting reading progress. */
export async function recordVisit(galleryId: number): Promise<void> {
  if (!isDbInitialized()) return;
  await getDb().execute(
    `INSERT INTO history (galleryId, lastPage, totalPages, readerMode, viewedAt)
     VALUES (?, 0, 0, '', ?)
     ON CONFLICT(galleryId) DO UPDATE SET
       viewedAt = excluded.viewedAt`,
    [galleryId, new Date().toISOString()],
  );
}

export async function getRecentlyViewedIds(limit = 100): Promise<number[]> {
  await initializeDatabase();
  const rows = await getDb().query<{ galleryId: number }>(
    'SELECT galleryId FROM history ORDER BY viewedAt DESC LIMIT ?',
    [limit],
  );
  return rows.map((r) => r.galleryId);
}

export async function getReadingProgress(
  galleryId: number,
): Promise<{ lastPage: number; totalPages: number; readerMode: string } | null> {
  if (!isDbInitialized()) return null;
  const rows = await getDb().query<{
    lastPage: number;
    totalPages: number;
    readerMode: string;
  }>('SELECT lastPage, totalPages, readerMode FROM history WHERE galleryId = ?', [galleryId]);
  return rows[0] ?? null;
}

export async function saveGalleryImages(galleryId: number, files: GalleryFile[]): Promise<void> {
  const db = getDb();
  await db.execute('DELETE FROM gallery_image WHERE galleryId = ?', [galleryId]);
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    await db.execute(
      `INSERT INTO gallery_image (galleryId, pageIndex, width, height, haswebp, hasavif, hasavifsmalltn, name, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [galleryId, i, file.width, file.height, file.haswebp, file.hasavif, file.hasavifsmalltn, file.name, file.hash],
    );
  }
}

export async function getGalleryImages(galleryId: number): Promise<GalleryFile[] | null> {
  const rows = await getDb().query<GalleryFile>(
    `SELECT width, height, haswebp, hasavif, hasavifsmalltn, name, hash
     FROM gallery_image WHERE galleryId = ? ORDER BY pageIndex ASC`,
    [galleryId],
  );
  if (rows.length === 0) return null;
  return rows;
}

export async function hasGalleryImages(galleryId: number): Promise<boolean> {
  const rows = await getDb().query<{ c: number }>(
    'SELECT COUNT(*) as c FROM gallery_image WHERE galleryId = ?',
    [galleryId],
  );
  return rows[0].c > 0;
}

export async function deleteGalleryImages(galleryId: number): Promise<void> {
  await getDb().execute('DELETE FROM gallery_image WHERE galleryId = ?', [galleryId]);
}
