import { getDb } from './adapter';
import { parseQuery } from '@/lib/api/search';
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
  const db = getDb();
  const prefix = query.toLowerCase() + '%';

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
  const i18nRows = await db.query<{ tagId: number; local: string }>(
    `SELECT i.tagId, i.local FROM tag_i18n i WHERE i.tagId IN (${filtered.map((t) => t.tagId).join(',') || '0'})`,
    [],
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
  const db = getDb();
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
  const q = '%' + titleQuery.toLowerCase() + '%';
  const rows = await getDb().query<{ id: number }>(
    'SELECT id FROM gallery WHERE LOWER(title) LIKE ?',
    [q],
  );
  return rows.map((r) => r.id).sort((a, b) => b - a);
}

export async function searchLocalGalleryIds(
  query: string,
): Promise<number[]> {
  const { tagType, tag } = parseQuery(query);

  if (tagType) {
    return searchLocalGalleryIdsByTag(tagType as TagType, tag);
  }

  // General query: merge tag-prefix matches + title matches
  const db = getDb();
  const prefix = query.toLowerCase() + '%';
  const matchingTags = await db.query<{ tagId: number }>(
    'SELECT tagId FROM tag WHERE name LIKE ? LIMIT 5',
    [prefix],
  );

  const [tagGalleryIds, titleIds] = await Promise.all([
    Promise.all(
      matchingTags.map((t) =>
        db.query<{ id: number }>('SELECT id FROM gallery_tag WHERE tagId = ?', [t.tagId])
          .then((rows) => rows.map((r) => r.id)),
      ),
    ).then((nested) => nested.flat()),
    searchLocalGalleryIdsByTitle(query),
  ]);

  const allIds = [...tagGalleryIds, ...titleIds];
  const unique = [...new Set(allIds)];
  return unique.sort((a, b) => b - a);
}

export async function hasLocalSearchData(): Promise<boolean> {
  const rows = await getDb().query<{ c: number }>('SELECT COUNT(*) as c FROM tag');
  return rows[0].c > 0;
}
