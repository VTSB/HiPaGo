import { apiClient } from './client';
import {
  INDEX_DIR,
  GALLERIES_INDEX_DIR,
  NOZOMIURL_INDEX_DIR,
  MAX_NODE_SIZE,
  B,
  SEARCH_LIMIT,
} from '@/lib/utils/constants';
import type { IndexData, IndexNode, Suggestion, SortOrder } from '@/lib/utils/types';
import { TagType } from '@/lib/utils/types';
import { tagFromSearch } from '@/lib/utils/hitomi-tag';
import { fetchIndexVersion } from './gallery';
import { fetchNozomiSearch } from './nozomi';
import { resolveTagIndexUrl } from './url-resolver';

async function hashTerm(term: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(term);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hashBuffer.slice(0, 4));
}

/**
 * Map of special field names to their directory and file name.
 * Tag-type fields (artist, series, etc.) use INDEX_DIR with the field as file name.
 */
const FIELD_CONFIG: Record<string, { dir: string; file: string }> = {
  galleries: { dir: GALLERIES_INDEX_DIR, file: 'galleries' },
  languages: { dir: 'languagesindex', file: 'languages' },
  nozomiurl: { dir: NOZOMIURL_INDEX_DIR, file: 'nozomiurl' },
};

/**
 * Build the correct index/data file path for a given field and version.
 * Matches hitomi's URL pattern: {dir}/{filename}.{version}.{ext}
 *
 * Examples:
 *   getIndexPath('galleries', 'v123', 'index') → 'galleriesindex/galleries.v123.index'
 *   getIndexPath('artist', 'v456', 'data')     → 'tagindex/artist.v456.data'
 *   getIndexPath('tag', 'v789', 'index')        → 'tagindex/tag.v789.index'
 */
function getIndexPath(field: string, version: string, ext: 'index' | 'data'): string {
  const config = FIELD_CONFIG[field];
  if (config) {
    return `${config.dir}/${config.file}.${version}.${ext}`;
  }
  // Tag-type fields: directory is INDEX_DIR, file is the field name
  return `${INDEX_DIR}/${field}.${version}.${ext}`;
}

/**
 * Get the directory used for version fetching for a given field.
 * Version endpoint: {dir}/version?_=timestamp
 */
function getVersionDir(field: string): string {
  const config = FIELD_CONFIG[field];
  if (config) return config.dir;
  return INDEX_DIR;
}

export function decodeNode(data: ArrayBuffer): IndexNode {
  const view = new DataView(data);
  let offset = 0;

  const numberOfKeys = view.getInt32(offset, false);
  offset += 4;

  const keys: Uint8Array[] = [];
  for (let i = 0; i < numberOfKeys; i++) {
    const keyLength = view.getInt32(offset, false);
    offset += 4;
    if (keyLength > 0 && keyLength <= 32) {
      keys.push(new Uint8Array(data, offset, keyLength));
      offset += keyLength;
    }
  }

  const numberOfDatas = view.getInt32(offset, false);
  offset += 4;

  const datas: IndexData[] = [];
  for (let i = 0; i < numberOfDatas; i++) {
    const dataOffset = Number(view.getBigInt64(offset, false));
    offset += 8;
    const dataLength = view.getInt32(offset, false);
    offset += 4;
    datas.push({ offset: dataOffset, length: dataLength });
  }

  const numberOfSubNodes = B + 1;
  const subNodeAddresses: number[] = [];
  for (let i = 0; i < numberOfSubNodes; i++) {
    if (offset + 8 <= data.byteLength) {
      subNodeAddresses.push(Number(view.getBigInt64(offset, false)));
      offset += 8;
    } else {
      subNodeAddresses.push(0);
    }
  }

  return { keys, datas, subNodeAddresses };
}

export function compareKeys(a: Uint8Array, b: Uint8Array): number {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

async function getNodeAtAddress(
  field: string,
  address: number,
  version: string,
): Promise<IndexNode | null> {
  try {
    const path = getIndexPath(field, version, 'index');
    const data = await apiClient.fetchLtnBinary(
      path,
      `bytes=${address}-${address + MAX_NODE_SIZE - 1}`,
    );
    return decodeNode(data);
  } catch {
    // Recoverable: binary search tree node fetch/decode failed — treat as empty subtree
    return null;
  }
}

async function bTreeSearch(
  field: string,
  key: Uint8Array,
  node: IndexNode | null,
  version: string,
): Promise<IndexData | null> {
  if (!node) return null;

  let lo = 0;
  let hi = node.keys.length - 1;
  let found = false;
  let idx = 0;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const cmp = compareKeys(key, node.keys[mid]);
    if (cmp < 0) {
      hi = mid - 1;
    } else if (cmp > 0) {
      lo = mid + 1;
    } else {
      found = true;
      idx = mid;
      break;
    }
  }

  if (found) return node.datas[idx] || null;

  const subIdx = lo;
  if (
    subIdx < node.subNodeAddresses.length &&
    node.subNodeAddresses[subIdx] !== 0
  ) {
    const subNode = await getNodeAtAddress(
      field,
      node.subNodeAddresses[subIdx],
      version,
    );
    return bTreeSearch(field, key, subNode, version);
  }

  return null;
}

export function parseQuery(query: string): { tagType: string | null; tag: string } {
  const colonIndex = query.indexOf(':');
  if (colonIndex > 0) {
    const possibleType = query.slice(0, colonIndex).toLowerCase();
    if (
      (Object.values(TagType) as string[]).includes(possibleType)
    ) {
      // Convert underscores back to spaces — tag links encode spaces as underscores
      // but hitomi's API uses actual spaces in tag names
      return { tagType: possibleType, tag: tagFromSearch(query.slice(colonIndex + 1).trim(), possibleType as TagType).displayForm };
    }
  }
  return { tagType: null, tag: tagFromSearch(query, TagType.TAG).displayForm };
}

/**
 * Parse a compound query into individual search terms.
 * Splits on whitespace — hitomi tags use underscores for spaces.
 * Examples:
 *   "female:loli artist:yam" → ["female:loli", "artist:yam"]
 *   "female:loli test" → ["female:loli", "test"]
 *   "loli" → ["loli"]
 */
export function parseCompoundQuery(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Intersect multiple ID arrays using Set-based lookup.
 * Nozomi files are mostly descending but have occasional ordering violations,
 * so a sorted-merge approach doesn't work reliably.
 */
function intersectIdSets(sets: number[][]): number[] {
  if (sets.length === 0) return [];
  if (sets.length === 1) return sets[0];

  // Start with the shortest set for the initial lookup set
  const sorted = [...sets].sort((a, b) => a.length - b.length);
  let currentSet = new Set(sorted[0]);

  for (let i = 1; i < sorted.length; i++) {
    const next = new Set<number>();
    for (const id of sorted[i]) {
      if (currentSet.has(id)) next.add(id);
    }
    currentSet = next;
    if (currentSet.size === 0) return [];
  }

  // Preserve the order from the first (shortest) set
  return sorted[0].filter((id) => currentSet.has(id));
}

export function decodeGalleryIdData(buffer: ArrayBuffer): number[] {
  const view = new DataView(buffer);
  if (buffer.byteLength < 4) return [];

  const count = view.getInt32(0, false);
  const ids: number[] = [];
  let pos = 4;
  for (let i = 0; i < count && pos + 4 <= buffer.byteLength; i++) {
    ids.push(view.getInt32(pos, false));
    pos += 4;
  }
  return ids;
}

/**
 * Get gallery IDs for a single search term.
 *
 * Typed queries (field:value) use nozomi files, matching hitomi's actual behavior:
 *   female:tag / male:tag → nozomi n/tag/{query}-{language}.nozomi
 *   language:lang         → nozomi n/index-{lang}.nozomi
 *   artist:name etc.      → nozomi n/{field}/{name}-{language}.nozomi
 *
 * Untyped queries use the B-tree galleries index.
 */
async function getGalleryIdsForSingleTerm(
  query: string,
  language: string,
  sort?: SortOrder,
): Promise<number[]> {
  const { tagType, tag } = parseQuery(query);

  if (tagType) {
    let area: string;
    let nozomiTag: string;
    let nozomiLanguage = language || 'all';

    if (tagType === 'male' || tagType === 'female') {
      area = 'tag';
      nozomiTag = `${tagType}:${tag}`;
    } else if (tagType === 'language') {
      area = '';
      nozomiTag = 'index';
      nozomiLanguage = tag;
    } else {
      area = tagType;
      nozomiTag = tag;
    }

    return fetchNozomiSearch(area, nozomiTag, nozomiLanguage, sort);
  }

  // Untyped queries → B-tree galleries index (lowercase for case-insensitive match)
  const field = 'galleries';
  const term = query.toLowerCase();

  const versionDir = getVersionDir(field);
  const version = await fetchIndexVersion(versionDir);
  const key = await hashTerm(term);
  const rootNode = await getNodeAtAddress(field, 0, version);
  const data = await bTreeSearch(field, key, rootNode, version);

  if (!data) return [];

  const dataPath = getIndexPath(field, version, 'data');
  const nozomiData = await apiClient.fetchLtnBinary(
    dataPath,
    `bytes=${data.offset}-${data.offset + data.length - 1}`,
  );

  return decodeGalleryIdData(nozomiData);
}

/**
 * Get gallery IDs for a (potentially compound) search query.
 *
 * Matches hitomi.la's do_search() algorithm (results.js):
 *   1. Split query into terms, categorize as positive or negative (- prefix)
 *   2. Sort positive terms: typed (field:value) terms first (optimization)
 *   3. Fetch ALL positive terms via getGalleryIdsForSingleTerm and intersect (AND)
 *   4. Fetch negative terms and exclude from results
 *
 * Sort order is only meaningful for single-term queries (nozomi files support
 * sort; B-tree galleriesindex does not). Multi-term queries ignore sort.
 */
export async function getGalleryIdsForQuery(
  query: string,
  language: string,
  sort?: SortOrder,
): Promise<number[]> {
  const terms = parseCompoundQuery(query);
  if (terms.length === 0) return [];

  // Single term: pass sort through
  if (terms.length === 1) {
    const term = terms[0];
    if (term.startsWith('-') && term.length > 1) {
      // Single negative term with no positive terms: no results
      return [];
    }
    return getGalleryIdsForSingleTerm(term, language, sort);
  }

  // Separate positive and negative terms
  const positiveTerms: string[] = [];
  const negativeTerms: string[] = [];

  for (const term of terms) {
    if (term.startsWith('-') && term.length > 1) {
      // Strip '-' prefix before storing — getGalleryIdsForSingleTerm needs the clean term
      negativeTerms.push(term.slice(1));
    } else {
      positiveTerms.push(term);
    }
  }

  // Sort positive terms: typed terms (containing ':') first
  // This matches hitomi.la's optimization — typed terms via nozomi are typically
  // smaller result sets, so fetching them first is more efficient
  positiveTerms.sort((a, b) => {
    const aTyped = a.includes(':');
    const bTyped = b.includes(':');
    if (aTyped && !bTyped) return -1;
    if (!aTyped && bTyped) return 1;
    return 0;
  });

  if (positiveTerms.length === 0) return [];

  // Fetch positive and negative terms in parallel
  const [positiveSets, negativeSets] = await Promise.all([
    Promise.all(positiveTerms.map((term) => getGalleryIdsForSingleTerm(term, language))),
    negativeTerms.length > 0
      ? Promise.all(negativeTerms.map((term) => getGalleryIdsForSingleTerm(term, language)))
      : Promise.resolve([]),
  ]);

  let results = intersectIdSets(positiveSets);

  if (negativeSets.length > 0 && results.length > 0) {
    const excludeSet = new Set(negativeSets.flat());
    results = results.filter((id) => !excludeSet.has(id));
  }

  return results;
}

/**
 * Decode suggestion data from a B-tree data segment.
 * Format: [count:int32] [ns_len:int32 ns_bytes tag_len:int32 tag_bytes amount:int32] × count
 */
export function decodeSuggestionData(
  buffer: ArrayBuffer,
  tagType: string | null,
): Suggestion[] {
  const view = new DataView(buffer);
  const suggestions: Suggestion[] = [];

  if (buffer.byteLength < 4) return [];

  let pos = 0;

  // First int32 is the number of suggestions
  const count = view.getInt32(pos, false);
  pos += 4;

  if (count <= 0) return [];

  const decoder = new TextDecoder('utf-8');

  for (let i = 0; i < count && pos < buffer.byteLength; i++) {
    // Read namespace string
    if (pos + 4 > buffer.byteLength) break;
    const nsLen = view.getInt32(pos, false);
    pos += 4;
    if (nsLen < 0 || pos + nsLen > buffer.byteLength) break;
    const ns = String.fromCharCode(...new Uint8Array(buffer, pos, nsLen));
    pos += nsLen;

    // Read tag string (UTF-8)
    if (pos + 4 > buffer.byteLength) break;
    const tagLen = view.getInt32(pos, false);
    pos += 4;
    if (tagLen < 0 || pos + tagLen > buffer.byteLength) break;
    const tagStr = decoder.decode(new Uint8Array(buffer, pos, tagLen));
    pos += tagLen;

    // Read count
    if (pos + 4 > buffer.byteLength) break;
    const amount = view.getInt32(pos, false);
    pos += 4;

    // Determine tag type from namespace or use provided
    let resolvedType: TagType;
    if (tagType) {
      resolvedType = tagType as TagType;
    } else if (ns && (Object.values(TagType) as string[]).includes(ns)) {
      resolvedType = ns as TagType;
    } else {
      resolvedType = TagType.TAG;
    }

    suggestions.push({
      tag: tagStr,
      tagType: resolvedType,
      amount,
    });
  }

  return suggestions.slice(0, SEARCH_LIMIT);
}

/**
 * Encode a character for tag index URL path.
 * Matches hitomi's encode_search_query_for_url: space→_, /→slash, .→dot
 */
function encodeTagIndexChar(c: string): string {
  if (c === ' ') return '_';
  if (c === '/') return 'slash';
  if (c === '.') return 'dot';
  return c;
}

/**
 * Get suggestions for a query using hitomi's tagindex JSON API.
 *
 * URL pattern: /api/tagindex/{field}/{char1}/{char2}/.../{charN}.json
 * Response: Array of [tag_name, count, namespace]
 */
export async function getSuggestionsForQuery(
  query: string,
): Promise<Suggestion[]> {
  const { tagType, tag } = parseQuery(query);
  const field = tagType || 'global';
  const term = (tag || query).toLowerCase();

  if (!term) return [];

  try {
    const chars = term.split('').map(encodeTagIndexChar);
    const path = `${field}/${chars.join('/')}.json`;
    const response = await apiClient.fetchUrl(resolveTagIndexUrl(path));
    const data: [string, number, string][] = await response.json();

    return data.slice(0, SEARCH_LIMIT).map(([tagName, count, ns]) => {
      let resolvedType: TagType;
      if (tagType) {
        resolvedType = tagType as TagType;
      } else if (ns && (Object.values(TagType) as string[]).includes(ns)) {
        resolvedType = ns as TagType;
      } else {
        resolvedType = TagType.TAG;
      }
      return { tag: tagName, tagType: resolvedType, amount: count };
    });
  } catch {
    // Recoverable: remote suggestion fetch failed — return empty suggestions
    return [];
  }
}
