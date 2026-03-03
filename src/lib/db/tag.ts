import { ensureDb } from './adapter';
import type { DBTag } from './schema';
import { TAG_TYPE_TO_BYTE, BYTE_TO_TAG_TYPE } from '@/lib/utils/types';
import type { TagType } from '@/lib/utils/types';

export async function findOrCreateTag(type: TagType, name: string): Promise<number> {
  const db = await ensureDb();
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
  if (tags.length === 0) return new Map();
  const db = await ensureDb();
  const result = new Map<string, number>();

  // Insert all tags at once (ignore duplicates)
  for (const { type, name } of tags) {
    await db.execute(
      'INSERT OR IGNORE INTO tag (type, name, count) VALUES (?, ?, 0)',
      [TAG_TYPE_TO_BYTE[type], name],
    );
  }

  // Batch fetch all tag IDs in chunks to stay within SQLite variable limits
  const QUERY_CHUNK = 50;
  const allRows: Array<{ tagId: number; type: number; name: string }> = [];
  for (let i = 0; i < tags.length; i += QUERY_CHUNK) {
    const chunk = tags.slice(i, i + QUERY_CHUNK);
    const conditions = chunk.map(() => '(type = ? AND name = ?)').join(' OR ');
    const params: (number | string)[] = chunk.flatMap(({ type, name }) => [TAG_TYPE_TO_BYTE[type], name]);
    const chunkRows = await db.query<{ tagId: number; type: number; name: string }>(
      `SELECT tagId, type, name FROM tag WHERE ${conditions}`,
      params,
    );
    allRows.push(...chunkRows);
  }
  for (const row of allRows) {
    const tagType = BYTE_TO_TAG_TYPE[row.type];
    if (tagType) result.set(`${tagType}:${row.name}`, row.tagId);
  }

  return result;
}

export async function getTag(tagId: number): Promise<DBTag | null> {
  const db = await ensureDb();
  const rows = await db.query<DBTag>(
    'SELECT tagId, type, name, count FROM tag WHERE tagId = ?',
    [tagId],
  );
  return rows[0] ?? null;
}

export async function getTagsByType(typeByte: number): Promise<DBTag[]> {
  const db = await ensureDb();
  return db.query<DBTag>(
    'SELECT tagId, type, name, count FROM tag WHERE type = ?',
    [typeByte],
  );
}

export async function updateTagCount(tagId: number, count: number): Promise<void> {
  const db = await ensureDb();
  await db.execute('UPDATE tag SET count = ? WHERE tagId = ?', [count, tagId]);
}

export async function setTagI18n(tagId: number, local: string): Promise<void> {
  const db = await ensureDb();
  await db.execute(
    'INSERT OR REPLACE INTO tag_i18n (tagId, local) VALUES (?, ?)',
    [tagId, local],
  );
}

export async function getTagI18n(tagId: number): Promise<string | null> {
  const db = await ensureDb();
  const rows = await db.query<{ local: string }>(
    'SELECT local FROM tag_i18n WHERE tagId = ?',
    [tagId],
  );
  return rows[0]?.local ?? null;
}

export async function setTagTransform(original: string, transformed: string): Promise<void> {
  const db = await ensureDb();
  await db.execute(
    'INSERT OR REPLACE INTO tag_transform (original, transformed) VALUES (?, ?)',
    [original, transformed],
  );
}

export async function getTagTransform(original: string): Promise<string | null> {
  const db = await ensureDb();
  const rows = await db.query<{ transformed: string }>(
    'SELECT transformed FROM tag_transform WHERE original = ?',
    [original],
  );
  return rows[0]?.transformed ?? null;
}

/** Batch lookup Korean names for tags by (type, name) pairs. Returns Map<"type:name", koreanName>. */
export async function batchGetTagI18n(
  tags: Array<{ type: TagType; name: string }>,
): Promise<Map<string, string>> {
  if (tags.length === 0) return new Map();
  const db = await ensureDb();

  // Batch fetch in chunks to stay within SQLite variable limits
  const QUERY_CHUNK = 50;
  const allRows: Array<{ type: number; name: string; local: string }> = [];
  for (let i = 0; i < tags.length; i += QUERY_CHUNK) {
    const chunk = tags.slice(i, i + QUERY_CHUNK);
    const conditions = chunk.map(() => '(t.type = ? AND t.name = ?)').join(' OR ');
    const params: (number | string)[] = chunk.flatMap(({ type, name }) => [TAG_TYPE_TO_BYTE[type], name]);
    const chunkRows = await db.query<{ type: number; name: string; local: string }>(
      `SELECT t.type, t.name, i.local FROM tag_i18n i
       JOIN tag t ON i.tagId = t.tagId
       WHERE ${conditions}`,
      params,
    );
    allRows.push(...chunkRows);
  }

  const result = new Map<string, string>();
  for (const row of allRows) {
    const tagType = BYTE_TO_TAG_TYPE[row.type];
    if (tagType) result.set(`${tagType}:${row.name}`, row.local);
  }
  return result;
}
