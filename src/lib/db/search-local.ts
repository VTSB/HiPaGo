import { ensureDb } from './adapter';
import { TAG_TYPE_TO_BYTE, BYTE_TO_TAG_TYPE } from '@/lib/utils/types';
import type { TagType, Suggestion } from '@/lib/utils/types';
import { useTagI18nStore } from '@/lib/store/tag-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { tagFromQualified, type HitomiTag } from '@/lib/utils/hitomi-tag';
import { prioritizeSuggestions } from '@/lib/utils/tag-favorites';

interface TagRow {
  tagId: number;
  type: number;
  name: string;
  count: number;
}

type SearchDb = Awaited<ReturnType<typeof ensureDb>>;

async function loadLocalCountMap(
  db: SearchDb,
  rows: readonly TagRow[],
): Promise<Map<number, number>> {
  const localCountMap = new Map<number, number>();
  const zeroCountIds = rows.filter((row) => row.count === 0).map((row) => row.tagId);

  const CHUNK = 50;
  for (let i = 0; i < zeroCountIds.length; i += CHUNK) {
    const chunk = zeroCountIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const counts = await db.query<{ tagId: number; cnt: number }>(
      `SELECT tagId, COUNT(*) as cnt FROM gallery_tag WHERE tagId IN (${placeholders}) GROUP BY tagId`,
      chunk,
    );
    for (const row of counts) localCountMap.set(row.tagId, row.cnt);
  }

  return localCountMap;
}

function effectiveCount(row: TagRow, localCountMap: ReadonlyMap<number, number>): number {
  return row.count > 0 ? row.count : (localCountMap.get(row.tagId) ?? 0);
}

function deduplicateRows(rows: readonly TagRow[]): TagRow[] {
  const seen = new Set<number>();
  return rows.filter((row) => {
    if (seen.has(row.tagId)) return false;
    seen.add(row.tagId);
    return true;
  });
}

async function loadFavoriteRows(
  db: SearchDb,
  favoriteTags: readonly string[],
  tagTypeFilter?: TagType,
): Promise<TagRow[]> {
  const parsed = favoriteTags
    .map((key) => tagFromQualified(key))
    .filter(
      (tag): tag is HitomiTag =>
        tag !== null && (tagTypeFilter === undefined || tag.type === tagTypeFilter),
    );

  const namesByType = new Map<number, Set<string>>();
  for (const tag of parsed) {
    const typeByte = TAG_TYPE_TO_BYTE[tag.type];
    const names = namesByType.get(typeByte) ?? new Set<string>();
    names.add(tag.searchForm.toLowerCase());
    names.add(tag.displayForm.toLowerCase());
    namesByType.set(typeByte, names);
  }
  if (namesByType.size === 0) return [];

  // Query once per namespace (and only chunk very large sets) instead of
  // building an OR branch per favorite. One parameter is reserved for type,
  // leaving ample headroom below SQLite's common 999-variable limit.
  const CHUNK = 900;
  const rows: TagRow[] = [];
  for (const [typeByte, names] of namesByType) {
    const allNames = Array.from(names);
    for (let i = 0; i < allNames.length; i += CHUNK) {
      const chunk = allNames.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      rows.push(
        ...(await db.query<TagRow>(
          `SELECT tagId, type, name, count FROM tag WHERE type = ? AND LOWER(name) IN (${placeholders})`,
          [typeByte, ...chunk],
        )),
      );
    }
  }

  return rows;
}

export async function searchLocalTags(
  query: string,
  tagTypeFilter?: TagType,
  limit: number = 20,
): Promise<Suggestion[]> {
  const db = await ensureDb();
  const trimmed = query.trim().toLowerCase();
  const i18nStore = useTagI18nStore.getState();
  const favoriteTags = useSettingsStore.getState().favoriteTags ?? [];

  // Empty query: merge the normal popular slice with exact favorite rows.
  // A favorite can be far below the SQL LIMIT by count, but it still belongs
  // at the front of the user-facing popular list.
  if (!trimmed) {
    const topTags =
      tagTypeFilter !== undefined
        ? await db.query<TagRow>(
            'SELECT tagId, type, name, count FROM tag WHERE type = ? ORDER BY CASE WHEN count > 0 THEN count ELSE (SELECT COUNT(*) FROM gallery_tag WHERE tagId = tag.tagId) END DESC LIMIT ?',
            [TAG_TYPE_TO_BYTE[tagTypeFilter], limit],
          )
        : await db.query<TagRow>(
            'SELECT tagId, type, name, count FROM tag ORDER BY CASE WHEN count > 0 THEN count ELSE (SELECT COUNT(*) FROM gallery_tag WHERE tagId = tag.tagId) END DESC LIMIT ?',
            [limit],
          );
    const favoriteRows = await loadFavoriteRows(db, favoriteTags, tagTypeFilter);
    const merged = deduplicateRows([...topTags, ...favoriteRows]);
    const localCountMap = await loadLocalCountMap(db, merged);
    merged.sort((a, b) => effectiveCount(b, localCountMap) - effectiveCount(a, localCountMap));

    const suggestions = merged
      .filter((row) => BYTE_TO_TAG_TYPE[row.type] !== undefined)
      .map((row) => {
        const tagType = BYTE_TO_TAG_TYPE[row.type];
        return {
          tag: row.name,
          tagType,
          amount: effectiveCount(row, localCountMap),
          localName: i18nStore.isLoaded
            ? i18nStore.getLocal(tagType as string, row.name)
            : undefined,
        };
      });

    return prioritizeSuggestions(suggestions, favoriteTags).slice(0, limit);
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
    const i18nMatches = i18nStore.searchByLocal(
      trimmed,
      typeFilter ? { type: typeFilter } : undefined,
    );

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

  const merged = deduplicateRows([...primaryResults, ...secondaryResults]);
  const localCountMap = await loadLocalCountMap(db, merged);

  // Preserve the established count ranking within each partition, but move
  // favorites ahead before applying the result limit.
  merged.sort((a, b) => {
    return effectiveCount(b, localCountMap) - effectiveCount(a, localCountMap);
  });

  const suggestions = merged
    .filter((row) => BYTE_TO_TAG_TYPE[row.type] !== undefined)
    .map((row) => {
      const tagType = BYTE_TO_TAG_TYPE[row.type];
      return {
        tag: row.name,
        tagType,
        amount: effectiveCount(row, localCountMap),
        localName: i18nStore.isLoaded ? i18nStore.getLocal(tagType as string, row.name) : undefined,
      };
    });

  return prioritizeSuggestions(suggestions, favoriteTags).slice(0, limit);
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

  const rows = await db.query<{ id: number }>('SELECT id FROM gallery_tag WHERE tagId = ?', [
    tags[0].tagId,
  ]);
  return rows.map((r) => r.id).sort((a, b) => b - a);
}

export async function searchLocalGalleryIdsByTitle(titleQuery: string): Promise<number[]> {
  const db = await ensureDb();
  const q = '%' + titleQuery.toLowerCase() + '%';
  const rows = await db.query<{ id: number }>('SELECT id FROM gallery WHERE LOWER(title) LIKE ?', [
    q,
  ]);
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
