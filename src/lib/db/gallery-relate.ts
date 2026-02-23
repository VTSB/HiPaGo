import { getDb } from './adapter';

export async function saveGalleryRelated(galleryId: number, relatedIds: number[]): Promise<void> {
  const db = getDb();
  await db.execute('DELETE FROM gallery_relate WHERE id = ?', [galleryId]);
  for (const related of relatedIds) {
    await db.execute(
      'INSERT INTO gallery_relate (id, related) VALUES (?, ?)',
      [galleryId, related],
    );
  }
}

export async function getGalleryRelated(galleryId: number): Promise<number[]> {
  const rows = await getDb().query<{ related: number }>(
    'SELECT related FROM gallery_relate WHERE id = ?',
    [galleryId],
  );
  return rows.map((r) => r.related);
}

export async function deleteGalleryRelated(galleryId: number): Promise<void> {
  await getDb().execute('DELETE FROM gallery_relate WHERE id = ?', [galleryId]);
}
