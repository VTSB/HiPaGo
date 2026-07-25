import { ensureDb, type DbAdapter } from './adapter';

export async function saveGalleryRelated(
  galleryId: number,
  relatedIds: number[],
  transactionDb?: DbAdapter,
): Promise<void> {
  const db = transactionDb ?? (await ensureDb());
  await db.execute('DELETE FROM gallery_relate WHERE id = ?', [galleryId]);
  if (relatedIds.length === 0) return;
  // Batch insert in chunks of 50
  const CHUNK = 50;
  for (let i = 0; i < relatedIds.length; i += CHUNK) {
    const chunk = relatedIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '(?, ?)').join(', ');
    const params = chunk.flatMap((r) => [galleryId, r]);
    await db.execute(`INSERT INTO gallery_relate (id, related) VALUES ${placeholders}`, params);
  }
}

export async function getGalleryRelated(galleryId: number): Promise<number[]> {
  const db = await ensureDb();
  const rows = await db.query<{ related: number }>(
    'SELECT related FROM gallery_relate WHERE id = ?',
    [galleryId],
  );
  return rows.map((r) => r.related);
}

export async function deleteGalleryRelated(galleryId: number): Promise<void> {
  const db = await ensureDb();
  await db.execute('DELETE FROM gallery_relate WHERE id = ?', [galleryId]);
}
