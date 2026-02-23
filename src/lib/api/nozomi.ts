import { apiClient } from './client';
import { BYTES_PER_ID, PAGE_SIZE } from '@/lib/utils/constants';
import type { GalleryIds, SortOrder } from '@/lib/utils/types';

const SORT_PERIOD: Record<string, string> = {
  popular_year: 'year',
  popular_month: 'month',
  popular_week: 'week',
  popular_day: 'today',
};

function getSortPeriod(sort?: SortOrder): string | null {
  if (!sort || sort === 'date_added') return null;
  return SORT_PERIOD[sort] ?? null;
}

export function parseNozomiData(buffer: ArrayBuffer): number[] {
  const view = new DataView(buffer);
  const ids: number[] = [];
  for (let i = 0; i + BYTES_PER_ID <= buffer.byteLength; i += BYTES_PER_ID) {
    ids.push(view.getInt32(i, false));
  }
  return ids;
}

export function calculateRange(
  page: number,
  pageSize: number = PAGE_SIZE,
): string {
  const start = page * pageSize * BYTES_PER_ID;
  const end = start + pageSize * BYTES_PER_ID - 1;
  return `bytes=${start}-${end}`;
}

export async function fetchGalleryIds(
  type: string,
  language: string,
  page: number,
  pageSize: number = PAGE_SIZE,
  sort?: SortOrder,
): Promise<GalleryIds> {
  const period = getSortPeriod(sort);
  // popular: popular/{period}-{language}.nozomi (replaces type)
  const path = period
    ? `popular/${period}-${language}.nozomi`
    : `${type}-${language}.nozomi`;
  const range = calculateRange(page, pageSize);
  const { data, total } = await apiClient.fetchLtnBinaryWithTotal(path, range);
  const idList = parseNozomiData(data);
  const length = total ? Math.floor(total / BYTES_PER_ID) : idList.length;
  return { idList, length };
}

export async function fetchGalleryIdsByTag(
  type: string,
  tag: string,
  language: string,
  page: number,
  pageSize: number = PAGE_SIZE,
): Promise<GalleryIds> {
  const path = `${type}/${encodeURIComponent(tag)}-${language}.nozomi`;
  const range = calculateRange(page, pageSize);
  const { data, total } = await apiClient.fetchLtnBinaryWithTotal(path, range);
  const idList = parseNozomiData(data);
  const length = total ? Math.floor(total / BYTES_PER_ID) : idList.length;
  return { idList, length };
}

/**
 * Fetch gallery IDs for a tag search using nozomi files with the 'n/' prefix.
 *
 * Paths:
 *   female:tag / male:tag → n/tag/{tagType}:{tag}-{language}.nozomi
 *   artist:name           → n/artist/{name}-{language}.nozomi
 *   language:lang         → n/index-{lang}.nozomi
 *
 * Popular sort (period goes AFTER the area):
 *   n/{area}/popular/{period}/{tag}-{language}.nozomi
 *   popular/{period}-{language}.nozomi  (language search, same as main index)
 */
export async function fetchNozomiSearch(
  area: string,
  tag: string,
  language: string,
  sort?: SortOrder,
): Promise<number[]> {
  const period = getSortPeriod(sort);
  const file = `${encodeURIComponent(tag)}-${language}.nozomi`;

  let path: string;
  if (!area) {
    // Language search (tag='index', language=actual lang)
    path = period
      ? `popular/${period}-${language}.nozomi`
      : `n/${file}`;
  } else {
    // Tag/artist/series search
    path = period
      ? `n/${area}/popular/${period}/${file}`
      : `n/${area}/${file}`;
  }

  const data = await apiClient.fetchLtnBinary(path);
  return parseNozomiData(data);
}
