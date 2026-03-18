import { ensureDb } from './adapter';
import { TAG_TYPE_TO_BYTE, BYTE_TO_TAG_TYPE } from '@/lib/utils/types';
import type { TagType, Suggestion } from '@/lib/utils/types';
import { useTagI18nStore } from '@/lib/store/tag-i18n';

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
  const i18nStore = useTagI18nStore.getState();

  // Empty query: return top tags by count directly from DB
  if (!trimmed) {
    const topTags = tagTypeFilter !== undefined
      ? await db.query<TagRow>(
          'SELECT tagId, type, name, count FROM tag WHERE type = ? ORDER BY CASE WHEN count > 0 THEN count ELSE (SELECT COUNT(*) FROM gallery_tag WHERE tagId = tag.tagId) END DESC LIMIT ?',
          [TAG_TYPE_TO_BYTE[tagTypeFilter], limit],
        )
      : await db.query<TagRow>(
          'SELECT tagId, type, name, count FROM tag ORDER BY CASE WHEN count > 0 THEN count ELSE (SELECT COUNT(*) FROM gallery_tag WHERE tagId = tag.tagId) END DESC LIMIT ?',
          [limit],
        );
    const filtered = topTags.filter((t) => BYTE_TO_TAG_TYPE[t.type] !== undefined);
    return filtered.map((t) => {
      const tagType = BYTE_TO_TAG_TYPE[t.type];
      return {
        tag: t.name,
        tagType,
        amount: t.count,
        localName: i18nStore.isLoaded ? i18nStore.getLocal(tagType as string, t.name) : undefined,
      };
    });
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

  // Secondary path: i18n name search via TagI18nStore
  const secondaryResults: TagRow[] = [];
  if (i18nStore.isLoaded) {
    const typeFilter = tagTypeFilter !== undefined ? (tagTypeFilter as string) : undefined;
    const i18nMatches = i18nStore.searchByLocal(trimmed, typeFilter ? { type: typeFilter } : undefined);

    if (i18nMatches.length > 0) {
      // Collect all names per type to batch-fetch from DB
      const byType = new Map<number, string[]>();
      for (const match of i18nMatches) {
        // Convert type string to byte for DB query
        const tagTypeEnum = match.type as TagType;
        const typeByte = TAG_TYPE_TO_BYTE[tagTypeEnum];
        if (typeByte === undefined) continue;
        if (!byType.has(typeByte)) byType.set(typeByte, []);
        byType.get(typeByte)!.push(match.name);
      }

      for (const [typeByte, names] of byType) {
        const CHUNK = 50;
        for (let i = 0; i < names.length; i += CHUNK) {
          const chunk = names.slice(i, i + CHUNK);
          const placeholders = chunk.map(() => '?').join(',');
          const rows = await db.query<TagRow>(
            `SELECT tagId, type, name, count FROM tag WHERE type = ? AND name IN (${placeholders})`,
            [typeByte, ...chunk],
          );
          secondaryResults.push(...rows);
        }
      }
    }
  }

  // Deduplicate by tagId
  const seen = new Set<number>();
  const merged = [...primaryResults, ...secondaryResults].filter((t) => {
    if (seen.has(t.tagId)) return false;
    seen.add(t.tagId);
    return true;
  });

  // Build effective count map for zero-count tags using local gallery_tag frequency
  const localCountMap = new Map<number, number>();
  const zeroCountIds = merged.filter((t) => t.count === 0).map((t) => t.tagId);
  if (zeroCountIds.length > 0) {
    const CHUNK = 50;
    for (let i = 0; i < zeroCountIds.length; i += CHUNK) {
      const chunk = zeroCountIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await db.query<{ tagId: number; cnt: number }>(
        `SELECT tagId, COUNT(*) as cnt FROM gallery_tag WHERE tagId IN (${placeholders}) GROUP BY tagId`,
        chunk,
      );
      for (const r of rows) localCountMap.set(r.tagId, r.cnt);
    }
  }

  // Sort by effective count descending, slice to limit
  merged.sort((a, b) => {
    const aEff = a.count > 0 ? a.count : (localCountMap.get(a.tagId) || 0);
    const bEff = b.count > 0 ? b.count : (localCountMap.get(b.tagId) || 0);
    return bEff - aEff;
  });
  const sliced = merged.slice(0, limit);

  const filtered = sliced.filter((t) => BYTE_TO_TAG_TYPE[t.type] !== undefined);
  if (filtered.length === 0) return [];

  return filtered.map((t) => {
    const tagType = BYTE_TO_TAG_TYPE[t.type];
    const effectiveCount = t.count > 0 ? t.count : (localCountMap.get(t.tagId) || 0);
    return {
      tag: t.name,
      tagType,
      amount: effectiveCount,
      localName: i18nStore.isLoaded ? i18nStore.getLocal(tagType as string, t.name) : undefined,
    };
  });
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
