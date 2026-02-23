import { getDb } from './adapter';
import type { DBTag } from './schema';
import { TAG_TYPE_TO_BYTE } from '@/lib/utils/types';
import type { TagType } from '@/lib/utils/types';

export async function findOrCreateTag(type: TagType, name: string): Promise<number> {
  const db = getDb();
  const typeByte = TAG_TYPE_TO_BYTE[type];

  const existing = await db.query<{ tagId: number }>(
    'SELECT tagId FROM tag WHERE type = ? AND name = ?',
    [typeByte, name],
  );
  if (existing.length > 0) return existing[0].tagId;

  const result = await db.execute(
    'INSERT INTO tag (type, name, count) VALUES (?, ?, 0)',
    [typeByte, name],
  );
  return result.lastInsertRowId;
}

export async function bulkFindOrCreateTags(
  tags: Array<{ type: TagType; name: string }>,
): Promise<Map<string, number>> {
  const db = getDb();
  const result = new Map<string, number>();

  for (const { type, name } of tags) {
    const typeByte = TAG_TYPE_TO_BYTE[type];
    const key = `${type}:${name}`;

    const existing = await db.query<{ tagId: number }>(
      'SELECT tagId FROM tag WHERE type = ? AND name = ?',
      [typeByte, name],
    );
    if (existing.length > 0) {
      result.set(key, existing[0].tagId);
    } else {
      const insertResult = await db.execute(
        'INSERT INTO tag (type, name, count) VALUES (?, ?, 0)',
        [typeByte, name],
      );
      result.set(key, insertResult.lastInsertRowId);
    }
  }

  return result;
}

export async function getTag(tagId: number): Promise<DBTag | null> {
  const rows = await getDb().query<DBTag>(
    'SELECT tagId, type, name, count FROM tag WHERE tagId = ?',
    [tagId],
  );
  return rows[0] ?? null;
}

export async function getTagsByType(typeByte: number): Promise<DBTag[]> {
  return getDb().query<DBTag>(
    'SELECT tagId, type, name, count FROM tag WHERE type = ?',
    [typeByte],
  );
}

export async function updateTagCount(tagId: number, count: number): Promise<void> {
  await getDb().execute('UPDATE tag SET count = ? WHERE tagId = ?', [count, tagId]);
}

export async function setTagI18n(tagId: number, local: string): Promise<void> {
  await getDb().execute(
    'INSERT OR REPLACE INTO tag_i18n (tagId, local) VALUES (?, ?)',
    [tagId, local],
  );
}

export async function getTagI18n(tagId: number): Promise<string | null> {
  const rows = await getDb().query<{ local: string }>(
    'SELECT local FROM tag_i18n WHERE tagId = ?',
    [tagId],
  );
  return rows[0]?.local ?? null;
}

export async function setTagTransform(original: string, transformed: string): Promise<void> {
  await getDb().execute(
    'INSERT OR REPLACE INTO tag_transform (original, transformed) VALUES (?, ?)',
    [original, transformed],
  );
}

export async function getTagTransform(original: string): Promise<string | null> {
  const rows = await getDb().query<{ transformed: string }>(
    'SELECT transformed FROM tag_transform WHERE original = ?',
    [original],
  );
  return rows[0]?.transformed ?? null;
}

/** Batch lookup Korean names for tags by (type, name) pairs. Returns Map<"type:name", koreanName>. */
export async function batchGetTagI18n(
  tags: Array<{ type: TagType; name: string }>,
): Promise<Map<string, string>> {
  const db = getDb();
  const result = new Map<string, string>();

  for (const { type, name } of tags) {
    const typeByte = TAG_TYPE_TO_BYTE[type];
    const rows = await db.query<{ local: string }>(
      `SELECT i.local FROM tag_i18n i
       JOIN tag t ON i.tagId = t.tagId
       WHERE t.type = ? AND t.name = ?`,
      [typeByte, name],
    );
    if (rows.length > 0) {
      result.set(`${type}:${name}`, rows[0].local);
    }
  }

  return result;
}
