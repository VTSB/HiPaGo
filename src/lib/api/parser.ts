import type {
  GalleryBlock,
  GalleryFile,
  GalleryImage,
  GalleryImages,
  GalleryInfo,
  GalleryTagJson,
  TagWithAmount,
} from '@/lib/utils/types';
import { GalleryBlockType, ImageType, TagType } from '@/lib/utils/types';
import { getThumbnailUrl } from '@/lib/utils/image-url';
import { resolveImgUrl } from './url-resolver';

export function parseGalleryJson(text: string): GalleryInfo {
  const jsonStr = text.replace(/^var\s+galleryinfo\s*=\s*/, '').trim();
  const data = JSON.parse(jsonStr);
  return {
    languageLocalName: data.language_localname || '',
    language: data.language || '',
    date: data.date || '',
    files: (data.files || []).map(parseGalleryFile),
    tags: (data.tags || []).map(parseGalleryTagJsonEntry),
    artists: Array.isArray(data.artists) ? data.artists.map((a: Record<string, string>) => a.artist || '').filter(Boolean) : [],
    groups: Array.isArray(data.groups) ? data.groups.map((g: Record<string, string>) => g.group || '').filter(Boolean) : [],
    characters: Array.isArray(data.characters) ? data.characters.map((c: Record<string, string>) => c.character || '').filter(Boolean) : [],
    parodys: Array.isArray(data.parodys) ? data.parodys.map((p: Record<string, string>) => p.parody || '').filter(Boolean) : [],
    japaneseTitle: data.japanese_title || '',
    title: data.title || '',
    id: typeof data.id === 'string' ? parseInt(data.id, 10) : data.id || 0,
    type: data.type || '',
    related: Array.isArray(data.related)
      ? data.related.map((r: unknown) => typeof r === 'string' ? parseInt(r, 10) : (r as number) || 0).filter((n: number) => n > 0)
      : [],
  };
}

function parseGalleryFile(data: Record<string, unknown>): GalleryFile {
  return {
    width: (data.width as number) || 0,
    height: (data.height as number) || 0,
    haswebp: (data.haswebp as number) || 0,
    hasavifsmalltn: (data.hasavifsmalltn as number) || 0,
    hasavif: (data.hasavif as number) || 0,
    name: (data.name as string) || '',
    hash: (data.hash as string) || '',
  };
}

function parseGalleryTagJsonEntry(
  data: Record<string, unknown>,
): GalleryTagJson {
  return {
    male: String(data.male || '0'),
    female: String(data.female || '0'),
    url: (data.url as string) || '',
    tag: (data.tag as string) || '',
  };
}

export function galleryInfoToImages(info: GalleryInfo): GalleryImages {
  return {
    id: info.id,
    images: info.files.map((file) => {
      const types = new Set<ImageType>([ImageType.ORIGINAL]);
      if (file.haswebp) types.add(ImageType.WEBP);
      if (file.hasavif) types.add(ImageType.AVIF);
      return {
        name: file.name,
        hash: file.hash,
        width: file.width,
        height: file.height,
        types,
      } satisfies GalleryImage;
    }),
  };
}

export function categorizeTags(
  tagsJson: GalleryTagJson[],
): Partial<Record<TagType, string[]>> {
  const result: Partial<Record<TagType, string[]>> = {};
  for (const tag of tagsJson) {
    let tagType: TagType;
    if (tag.male === '1') {
      tagType = TagType.MALE;
    } else if (tag.female === '1') {
      tagType = TagType.FEMALE;
    } else {
      const urlMatch = /^([^/]+)\//.exec(tag.url);
      if (urlMatch) {
        const urlType = urlMatch[1] as TagType;
        tagType = Object.values(TagType).includes(urlType)
          ? urlType
          : TagType.TAG;
      } else {
        tagType = TagType.TAG;
      }
    }
    if (!result[tagType]) result[tagType] = [];
    result[tagType]!.push(tag.tag);
  }
  return result;
}

export function parseGalleryBlockHtml(html: string, id: number): GalleryBlock {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const titleEl = doc.querySelector('.lillie a, h1 a');
  const title = titleEl?.textContent?.trim() || '';

  const dateEl = doc.querySelector('.date');
  const dateStr = dateEl?.textContent?.trim() || '';
  const date = dateStr ? parseDate(dateStr) : new Date();

  const imgEl = doc.querySelector('img');
  let thumbnail = '';
  if (imgEl) {
    thumbnail =
      imgEl.getAttribute('data-src') || imgEl.getAttribute('src') || '';
    if (thumbnail.startsWith('//')) thumbnail = `https:${thumbnail}`;
    thumbnail = rewriteHitomiUrl(thumbnail);
  }

  const tags: Partial<Record<TagType, string[]>> = {};
  const tagRows = doc.querySelectorAll('tr');
  for (const row of tagRows) {
    const headerEl = row.querySelector('td:first-child');
    const header =
      headerEl?.textContent?.trim().toLowerCase().replace(':', '') || '';
    const tagType = mapHeaderToTagType(header);
    if (!tagType) continue;
    const tagLinks = row.querySelectorAll('td:last-child a');
    for (const link of tagLinks) {
      let text = link.textContent?.trim();
      if (!text) continue;
      // Detect ♂/♀ suffix and split into male/female types
      let resolvedType = tagType;
      if (tagType === TagType.TAG) {
        if (text.endsWith(' ♂')) {
          resolvedType = TagType.MALE;
          text = text.slice(0, -2);
        } else if (text.endsWith(' ♀')) {
          resolvedType = TagType.FEMALE;
          text = text.slice(0, -2);
        }
      }
      if (!tags[resolvedType]) tags[resolvedType] = [];
      tags[resolvedType]!.push(text);
    }
  }

  const related = extractRelatedIds(doc);

  return {
    id,
    type: GalleryBlockType.NOT_DETAILED,
    title,
    date,
    tags,
    thumbnail,
    related,
  };
}

export function galleryInfoToBlock(info: GalleryInfo): GalleryBlock {
  const thumbnail =
    info.files.length > 0 ? getThumbnailUrl(info.files[0]) : '';
  const tags = categorizeTags(info.tags);
  // Merge top-level artist/group/character/series (parody) fields
  if (info.artists.length > 0) tags[TagType.ARTIST] = [...(tags[TagType.ARTIST] || []), ...info.artists];
  if (info.groups.length > 0) tags[TagType.GROUP] = [...(tags[TagType.GROUP] || []), ...info.groups];
  if (info.characters.length > 0) tags[TagType.CHARACTER] = [...(tags[TagType.CHARACTER] || []), ...info.characters];
  if (info.parodys.length > 0) tags[TagType.SERIES] = [...(tags[TagType.SERIES] || []), ...info.parodys];
  return {
    id: info.id,
    type: GalleryBlockType.DETAILED,
    title: info.title || info.japaneseTitle || '',
    date: parseDate(info.date),
    tags,
    thumbnail,
    related: info.related,
  };
}

export function parseDate(dateStr: string): Date {
  if (!dateStr) return new Date();
  const cleaned = dateStr.replace(/[-+]\d{2}$/, '').trim();
  const parsed = new Date(cleaned);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

function mapHeaderToTagType(header: string): TagType | null {
  const map: Record<string, TagType> = {
    type: TagType.TYPE,
    language: TagType.LANGUAGE,
    group: TagType.GROUP,
    artist: TagType.ARTIST,
    series: TagType.SERIES,
    character: TagType.CHARACTER,
    characters: TagType.CHARACTER,
    tag: TagType.TAG,
    tags: TagType.TAG,
  };
  return map[header] || null;
}

function extractRelatedIds(doc: Document): number[] {
  const scripts = doc.querySelectorAll('script');
  for (const script of scripts) {
    const content = script.textContent || '';
    const match = /related\s*=\s*\[([^\]]*)\]/.exec(content);
    if (match) {
      return match[1]
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));
    }
  }
  return [];
}

/**
 * Rewrite a direct hitomi CDN URL to go through our proxy.
 * Matches both old (.hitomi.la) and new (.gold-usergeneratedcontent.net) domains.
 * e.g., https://tn.hitomi.la/avifsmalltn/... → /api/img/tn/avifsmalltn/...
 *       https://atn.gold-usergeneratedcontent.net/avifsmalltn/... → /api/img/atn/avifsmalltn/...
 */
function rewriteHitomiUrl(url: string): string {
  const match = /^https?:\/\/([^.]+)\.(?:hitomi\.la|gold-usergeneratedcontent\.net)\/(.*)$/.exec(url);
  if (match) {
    return resolveImgUrl(match[1], match[2]);
  }
  return url;
}

export function parseLanguageSupport(text: string): string[] {
  const match = /\[([^\]]*)\]/.exec(text);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/['"]/g, ''))
    .filter(Boolean);
}

export function parseIndexVersion(text: string): string {
  return text.trim();
}

export function parseTagListHtml(html: string): TagWithAmount[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const results: TagWithAmount[] = [];
  const links = doc.querySelectorAll('a');
  for (const link of links) {
    const tag = link.textContent?.trim() || '';
    const amountMatch = /\((\d+)\)/.exec(
      link.nextSibling?.textContent || link.textContent || '',
    );
    const amount = amountMatch ? parseInt(amountMatch[1], 10) : 0;
    if (tag) results.push({ tag, amount });
  }
  return results;
}
