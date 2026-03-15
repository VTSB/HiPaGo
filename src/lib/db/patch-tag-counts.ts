import { ensureDb } from './adapter';
import { updateTagCount } from './tag';
import { TAG_TYPE_TO_BYTE } from '@/lib/utils/types';
import type { TagType } from '@/lib/utils/types';
import { apiClient } from '@/lib/api/client';
import { resolveTagIndexUrl } from '@/lib/api/url-resolver';

/**
 * Map TagType enum values to the tagindex API field name.
 * These match the field names used in getSuggestionsForQuery.
 */
const TAG_TYPE_TO_FIELD: Partial<Record<TagType, string>> = {
  artist: 'artist',
  series: 'series',
  character: 'character',
  group: 'group',
  tag: 'tag',
  female: 'female',
  male: 'male',
};

/**
 * Encode a single character for the tagindex URL path.
 * Matches hitomi's encode_search_query_for_url: space→_, /→slash, .→dot
 */
function encodeTagIndexChar(c: string): string {
  if (c === ' ') return '_';
  if (c === '/') return 'slash';
  if (c === '.') return 'dot';
  return c;
}

/**
 * Build the tagindex JSON path for a given field and tag name.
 * URL pattern: {field}/{char1}/{char2}/.../{charN}.json
 */
function buildTagIndexPath(field: string, name: string): string {
  const chars = name.toLowerCase().split('').map(encodeTagIndexChar);
  return `${field}/${chars.join('/')}.json`;
}

/**
 * Fetch the real gallery count for a single tag from the tagindex API.
 * Returns the count if the tag name is found in the response, otherwise null.
 */
async function fetchTagCount(field: string, name: string): Promise<number | null> {
  try {
    const path = buildTagIndexPath(field, name);
    const url = resolveTagIndexUrl(path);
    const response = await apiClient.fetchUrl(url);
    const data: [string, number, string][] = await response.json();

    // Find exact match by tag name
    const match = data.find(([tagName]) => tagName === name);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Patch the count field for tags that currently have count=0.
 *
 * Accepts Array<{type: TagType, name: string}> — no tagIds needed.
 * Resolves tagIds from DB internally, filters to count=0 tags,
 * fetches real counts from the tagindex API, and updates the DB.
 */
export async function patchNewTagCounts(
  tags: Array<{ type: TagType; name: string }>,
): Promise<void> {
  if (tags.length === 0) return;

  const db = await ensureDb();

  // Look up tagId and count for each tag from DB
  const zeroCountTags: Array<{ tagId: number; type: TagType; name: string }> = [];

  for (const { type, name } of tags) {
    const typeByte = TAG_TYPE_TO_BYTE[type];
    const rows = await db.query<{ tagId: number; count: number }>(
      'SELECT tagId, count FROM tag WHERE type = ? AND name = ?',
      [typeByte, name],
    );
    if (rows.length === 0) continue; // tag not in DB, skip
    const { tagId, count } = rows[0];
    if (count === 0) {
      zeroCountTags.push({ tagId, type, name });
    }
  }

  if (zeroCountTags.length === 0) return;

  // Fetch and update counts for zero-count tags
  for (const { tagId, type, name } of zeroCountTags) {
    const field = TAG_TYPE_TO_FIELD[type];
    if (!field) continue;

    const realCount = await fetchTagCount(field, name);
    if (realCount !== null && realCount > 0) {
      await updateTagCount(tagId, realCount);
    }
  }
}
