import { getDb } from './adapter';
import { TAG_TYPE_TO_BYTE, BYTE_TO_TAG_TYPE } from '@/lib/utils/types';
import type { TagType } from '@/lib/utils/types';

export async function saveGalleryTags(
  galleryId: number,
  tags: Partial<Record<TagType, string[]>>,
): Promise<void> {
  const db = getDb();

  // Delete existing junction entries
  await db.execute('DELETE FROM gallery_tag WHERE id = ?', [galleryId]);

  // Find or create each tag and create junction entries
  for (const [typeStr, names] of Object.entries(tags)) {
    const tagType = typeStr as TagType;
    const typeByte = TAG_TYPE_TO_BYTE[tagType];
    if (typeByte === undefined || !names) continue;

    for (const name of names) {
      // Find existing tag
      const existing = await db.query<{ tagId: number }>(
        'SELECT tagId FROM tag WHERE type = ? AND name = ?',
        [typeByte, name],
      );

      let tagId: number;
      if (existing.length > 0) {
        tagId = existing[0].tagId;
      } else {
        const result = await db.execute(
          'INSERT INTO tag (type, name, count) VALUES (?, ?, 0)',
          [typeByte, name],
        );
        tagId = result.lastInsertRowId;
      }

      await db.execute(
        'INSERT OR IGNORE INTO gallery_tag (id, tagId) VALUES (?, ?)',
        [galleryId, tagId],
      );
    }
  }
}

export async function getGalleryTags(
  galleryId: number,
): Promise<Partial<Record<TagType, string[]>>> {
  const rows = await getDb().query<{ tagId: number; type: number; name: string }>(
    `SELECT t.tagId, t.type, t.name
     FROM gallery_tag gt
     JOIN tag t ON gt.tagId = t.tagId
     WHERE gt.id = ?`,
    [galleryId],
  );

  const result: Partial<Record<TagType, string[]>> = {};
  for (const row of rows) {
    const tagType = BYTE_TO_TAG_TYPE[row.type];
    if (!tagType) continue;
    if (!result[tagType]) result[tagType] = [];
    result[tagType]!.push(row.name);
  }
  return result;
}

export async function deleteGalleryTags(galleryId: number): Promise<void> {
  await getDb().execute('DELETE FROM gallery_tag WHERE id = ?', [galleryId]);
}

export async function getGalleryIdsByTag(tagId: number): Promise<number[]> {
  const rows = await getDb().query<{ id: number }>(
    'SELECT id FROM gallery_tag WHERE tagId = ?',
    [tagId],
  );
  return rows.map((r) => r.id);
}
