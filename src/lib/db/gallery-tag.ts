import { ensureDb } from './adapter';
import { TAG_TYPE_TO_BYTE, BYTE_TO_TAG_TYPE } from '@/lib/utils/types';
import type { TagType } from '@/lib/utils/types';

export async function saveGalleryTags(
  galleryId: number,
  tags: Partial<Record<TagType, string[]>>,
): Promise<void> {
  const db = await ensureDb();

  // Delete existing junction entries
  await db.execute('DELETE FROM gallery_tag WHERE id = ?', [galleryId]);

  // Collect all tags to insert
  const allTags: Array<{ type: TagType; name: string }> = [];
  for (const [typeStr, names] of Object.entries(tags)) {
    const tagType = typeStr as TagType;
    const typeByte = TAG_TYPE_TO_BYTE[tagType];
    if (typeByte === undefined || !names) continue;
    for (const name of names) {
      allTags.push({ type: tagType, name });
    }
  }
  if (allTags.length === 0) return;

  // Ensure all tags exist (INSERT OR IGNORE) and fetch IDs in batch
  for (const { type, name } of allTags) {
    await db.execute(
      'INSERT OR IGNORE INTO tag (type, name, count) VALUES (?, ?, 0)',
      [TAG_TYPE_TO_BYTE[type], name],
    );
  }
  // Batch fetch tag IDs in chunks to stay within SQLite variable limits
  const QUERY_CHUNK = 50;
  const rows: Array<{ tagId: number; type: number; name: string }> = [];
  for (let i = 0; i < allTags.length; i += QUERY_CHUNK) {
    const chunk = allTags.slice(i, i + QUERY_CHUNK);
    const conditions = chunk.map(() => '(type = ? AND name = ?)').join(' OR ');
    const params = chunk.flatMap(({ type, name }) => [TAG_TYPE_TO_BYTE[type], name]);
    const chunkRows = await db.query<{ tagId: number; type: number; name: string }>(
      `SELECT tagId, type, name FROM tag WHERE ${conditions}`,
      params,
    );
    rows.push(...chunkRows);
  }
  const tagIdMap = new Map(rows.map((r) => [`${r.type}:${r.name}`, r.tagId]));

  // Batch insert junction entries
  const junctionPairs: [number, number][] = [];
  for (const { type, name } of allTags) {
    const tagId = tagIdMap.get(`${TAG_TYPE_TO_BYTE[type]}:${name}`);
    if (tagId !== undefined) junctionPairs.push([galleryId, tagId]);
  }
  const CHUNK = 50;
  for (let i = 0; i < junctionPairs.length; i += CHUNK) {
    const chunk = junctionPairs.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '(?, ?)').join(', ');
    const vals = chunk.flatMap(([gid, tid]) => [gid, tid]);
    await db.execute(`INSERT OR IGNORE INTO gallery_tag (id, tagId) VALUES ${placeholders}`, vals);
  }
}

export async function getGalleryTags(
  galleryId: number,
): Promise<Partial<Record<TagType, string[]>>> {
  const db = await ensureDb();
  const rows = await db.query<{ tagId: number; type: number; name: string }>(
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
  const db = await ensureDb();
  await db.execute('DELETE FROM gallery_tag WHERE id = ?', [galleryId]);
}

export async function getGalleryIdsByTag(tagId: number): Promise<number[]> {
  const db = await ensureDb();
  const rows = await db.query<{ id: number }>(
    'SELECT id FROM gallery_tag WHERE tagId = ?',
    [tagId],
  );
  return rows.map((r) => r.id);
}
