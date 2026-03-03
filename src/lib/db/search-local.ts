import { ensureDb } from './adapter';
import { TAG_TYPE_TO_BYTE, BYTE_TO_TAG_TYPE } from '@/lib/utils/types';
import type { TagType, Suggestion } from '@/lib/utils/types';

interface TagRow {
  tagId: number;
  type: number;
  name: string;
  count: number;
}

export async function searchLocalTags(
  query: string,
  tagTypeFilter?: TagType,
  limit: number = 20,
): Promise<Suggestion[]> {
  const db = await ensureDb();
  const trimmed = query.trim().toLowerCase();

  // Empty query: return top tags by count directly from DB
  if (!trimmed) {
    const topTags = tagTypeFilter !== undefined
      ? await db.query<TagRow>(
          'SELECT tagId, type, name, count FROM tag WHERE type = ? ORDER BY count DESC LIMIT ?',
          [TAG_TYPE_TO_BYTE[tagTypeFilter], limit],
        )
      : await db.query<TagRow>(
          'SELECT tagId, type, name, count FROM tag ORDER BY count DESC LIMIT ?',
          [limit],
        );
    const filtered = topTags.filter((t) => BYTE_TO_TAG_TYPE[t.type] !== undefined);
    if (filtered.length === 0) return [];
    const placeholders = filtered.map(() => '?').join(',');
    const i18nRows = await db.query<{ tagId: number; local: string }>(
      `SELECT i.tagId, i.local FROM tag_i18n i WHERE i.tagId IN (${placeholders})`,
      filtered.map((t) => t.tagId),
    );
    const i18nMap = new Map(i18nRows.map((r) => [r.tagId, r.local]));
    return filtered.map((t) => ({
      tag: t.name,
      tagType: BYTE_TO_TAG_TYPE[t.type],
      amount: t.count,
      localName: i18nMap.get(t.tagId),
    }));
  }

  const prefix = trimmed + '%';

  // Primary path: name prefix
  let primaryResults: TagRow[];
  if (tagTypeFilter !== undefined) {
    const typeByte = TAG_TYPE_TO_BYTE[tagTypeFilter];
    primaryResults = await db.query<TagRow>(
      'SELECT tagId, type, name, count FROM tag WHERE name LIKE ? AND type = ?',
      [prefix, typeByte],
    );
  } else {
    primaryResults = await db.query<TagRow>(
      'SELECT tagId, type, name, count FROM tag WHERE name LIKE ?',
      [prefix],
    );
  }

  // Secondary path: i18n name prefix
  let secondaryResults: TagRow[];
  if (tagTypeFilter !== undefined) {
    const typeByte = TAG_TYPE_TO_BYTE[tagTypeFilter];
    secondaryResults = await db.query<TagRow>(
      `SELECT t.tagId, t.type, t.name, t.count
       FROM tag_i18n i JOIN tag t ON i.tagId = t.tagId
       WHERE i.local LIKE ? AND t.type = ?`,
      [prefix, typeByte],
    );
  } else {
    secondaryResults = await db.query<TagRow>(
      `SELECT t.tagId, t.type, t.name, t.count
       FROM tag_i18n i JOIN tag t ON i.tagId = t.tagId
       WHERE i.local LIKE ?`,
      [prefix],
    );
  }

  // Deduplicate by tagId
  const seen = new Set<number>();
  const merged = [...primaryResults, ...secondaryResults].filter((t) => {
    if (seen.has(t.tagId)) return false;
    seen.add(t.tagId);
    return true;
  });

  // Sort by count descending, slice to limit
  merged.sort((a, b) => b.count - a.count);
  const sliced = merged.slice(0, limit);

  const filtered = sliced.filter((t) => BYTE_TO_TAG_TYPE[t.type] !== undefined);

  // Batch fetch Korean names
  if (filtered.length === 0) return [];
  const placeholders = filtered.map(() => '?').join(',');
  const i18nRows = await db.query<{ tagId: number; local: string }>(
    `SELECT i.tagId, i.local FROM tag_i18n i WHERE i.tagId IN (${placeholders})`,
    filtered.map((t) => t.tagId),
  );
  const i18nMap = new Map(i18nRows.map((r) => [r.tagId, r.local]));

  return filtered.map((t) => ({
    tag: t.name,
    tagType: BYTE_TO_TAG_TYPE[t.type],
    amount: t.count,
    localName: i18nMap.get(t.tagId),
  }));
}

export async function searchLocalGalleryIdsByTag(
  tagType: TagType,
  tagName: string,
): Promise<number[]> {
  const db = await ensureDb();
  const typeByte = TAG_TYPE_TO_BYTE[tagType];
  const tags = await db.query<{ tagId: number }>(
    'SELECT tagId FROM tag WHERE type = ? AND name = ?',
    [typeByte, tagName],
  );
  if (tags.length === 0) return [];

  const rows = await db.query<{ id: number }>(
    'SELECT id FROM gallery_tag WHERE tagId = ?',
    [tags[0].tagId],
  );
  return rows.map((r) => r.id).sort((a, b) => b - a);
}

export async function searchLocalGalleryIdsByTitle(
  titleQuery: string,
): Promise<number[]> {
  const db = await ensureDb();
  const q = '%' + titleQuery.toLowerCase() + '%';
  const rows = await db.query<{ id: number }>(
    'SELECT id FROM gallery WHERE LOWER(title) LIKE ?',
    [q],
  );
  return rows.map((r) => r.id).sort((a, b) => b - a);
}


export async function filterHistoryByTags(
  tags: Array<{ type: TagType; name: string }>,
  titleQuery?: string,
): Promise<number[]> {
  const db = await ensureDb();

  if (tags.length === 0 && !titleQuery) {
    const rows = await db.query<{ galleryId: number }>(
      'SELECT galleryId FROM history ORDER BY viewedAt DESC',
      [],
    );
    return rows.map((r) => r.galleryId);
  }

  // Resolve tag names to tagIds
  const tagIds: number[] = [];
  for (const tag of tags) {
    const typeByte = TAG_TYPE_TO_BYTE[tag.type];
    const found = await db.query<{ tagId: number }>(
      'SELECT tagId FROM tag WHERE type = ? AND name = ?',
      [typeByte, tag.name],
    );
    if (found.length === 0) return [];
    tagIds.push(found[0].tagId);
  }

  const titleLike = titleQuery ? '%' + titleQuery.toLowerCase() + '%' : null;

  if (tagIds.length > 0 && titleLike) {
    const placeholders = tagIds.map(() => '?').join(',');
    const rows = await db.query<{ galleryId: number }>(
      `SELECT h.galleryId
       FROM history h
       JOIN gallery_tag gt ON gt.id = h.galleryId
       JOIN gallery g ON g.id = h.galleryId
       WHERE gt.tagId IN (${placeholders})
         AND LOWER(g.title) LIKE ?
       GROUP BY h.galleryId
       HAVING COUNT(DISTINCT gt.tagId) = ?
       ORDER BY h.viewedAt DESC`,
      [...tagIds, titleLike, tagIds.length],
    );
    return rows.map((r) => r.galleryId);
  }

  if (tagIds.length > 0) {
    const placeholders = tagIds.map(() => '?').join(',');
    const rows = await db.query<{ galleryId: number }>(
      `SELECT h.galleryId
       FROM history h
       JOIN gallery_tag gt ON gt.id = h.galleryId
       WHERE gt.tagId IN (${placeholders})
       GROUP BY h.galleryId
       HAVING COUNT(DISTINCT gt.tagId) = ?
       ORDER BY h.viewedAt DESC`,
      [...tagIds, tagIds.length],
    );
    return rows.map((r) => r.galleryId);
  }

  // titleQuery only (tags empty but titleQuery provided)
  const rows = await db.query<{ galleryId: number }>(
    `SELECT h.galleryId
     FROM history h
     JOIN gallery g ON g.id = h.galleryId
     WHERE LOWER(g.title) LIKE ?
     ORDER BY h.viewedAt DESC`,
    [titleLike],
  );
  return rows.map((r) => r.galleryId);
}

export async function filterFavoritesByTags(
  tags: Array<{ type: TagType; name: string }>,
  titleQuery?: string,
): Promise<number[]> {
  const db = await ensureDb();

  if (tags.length === 0 && !titleQuery) {
    const rows = await db.query<{ galleryId: number }>(
      'SELECT galleryId FROM favorites ORDER BY addedAt DESC',
      [],
    );
    return rows.map((r) => r.galleryId);
  }

  // Resolve tag names to tagIds
  const tagIds: number[] = [];
  for (const tag of tags) {
    const typeByte = TAG_TYPE_TO_BYTE[tag.type];
    const found = await db.query<{ tagId: number }>(
      'SELECT tagId FROM tag WHERE type = ? AND name = ?',
      [typeByte, tag.name],
    );
    if (found.length === 0) return [];
    tagIds.push(found[0].tagId);
  }

  const titleLike = titleQuery ? '%' + titleQuery.toLowerCase() + '%' : null;

  if (tagIds.length > 0 && titleLike) {
    const placeholders = tagIds.map(() => '?').join(',');
    const rows = await db.query<{ galleryId: number }>(
      `SELECT f.galleryId
       FROM favorites f
       JOIN gallery_tag gt ON gt.id = f.galleryId
       JOIN gallery g ON g.id = f.galleryId
       WHERE gt.tagId IN (${placeholders})
         AND LOWER(g.title) LIKE ?
       GROUP BY f.galleryId
       HAVING COUNT(DISTINCT gt.tagId) = ?
       ORDER BY f.addedAt DESC`,
      [...tagIds, titleLike, tagIds.length],
    );
    return rows.map((r) => r.galleryId);
  }

  if (tagIds.length > 0) {
    const placeholders = tagIds.map(() => '?').join(',');
    const rows = await db.query<{ galleryId: number }>(
      `SELECT f.galleryId
       FROM favorites f
       JOIN gallery_tag gt ON gt.id = f.galleryId
       WHERE gt.tagId IN (${placeholders})
       GROUP BY f.galleryId
       HAVING COUNT(DISTINCT gt.tagId) = ?
       ORDER BY f.addedAt DESC`,
      [...tagIds, tagIds.length],
    );
    return rows.map((r) => r.galleryId);
  }

  // titleQuery only (tags empty but titleQuery provided)
  const rows = await db.query<{ galleryId: number }>(
    `SELECT f.galleryId
     FROM favorites f
     JOIN gallery g ON g.id = f.galleryId
     WHERE LOWER(g.title) LIKE ?
     ORDER BY f.addedAt DESC`,
    [titleLike],
  );
  return rows.map((r) => r.galleryId);
}

export async function hasLocalSearchData(): Promise<boolean> {
  const db = await ensureDb();
  const rows = await db.query<{ c: number }>('SELECT COUNT(*) as c FROM tag');
  return rows[0].c > 0;
}
