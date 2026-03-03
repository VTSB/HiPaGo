export interface ParsedTag {
  name: string;
  count: number;
  type: string; // 'artist' | 'series' | 'character' | 'group' | 'tag' | 'female' | 'male'
}

export const TAG_TYPES: ReadonlyArray<{ urlType: string; defaultType: string }> = [
  { urlType: 'artists', defaultType: 'artist' },
  { urlType: 'series', defaultType: 'series' },
  { urlType: 'characters', defaultType: 'character' },
  { urlType: 'groups', defaultType: 'group' },
  { urlType: 'tags', defaultType: 'tag' },
] as const;

// Unescape HTML entities: named + numeric decimal + numeric hex
function unescapeHtml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Strip all HTML tags from a string
function stripHtmlTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

const CONTENT_RE = /class="content"[^>]*><ul[^>]*>([\s\S]*?)<\/ul>/;
const TAG_RE = /<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>\s*\((\d[\d,]*)\)/g;
const NAV_RE = /class="page-content"[\s\S]*?<\/ul>/;
const HREF_RE = /href="([^"]+\.html)"/g;
const FEMALE_SUFFIX_RE = /\s*♀\s*$/;
const MALE_SUFFIX_RE = /\s*♂\s*$/;

/**
 * Parse tag entries from a hitomi.la tag page HTML.
 */
export function parseTagsFromHtml(html: string, defaultType: string): ParsedTag[] {
  const contentMatch = CONTENT_RE.exec(html);
  if (!contentMatch) return [];

  const contentBlock = contentMatch[1];
  const tags: ParsedTag[] = [];

  // Reset lastIndex since TAG_RE is a module-level regex with /g flag
  TAG_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(contentBlock)) !== null) {
    const hrefRaw = match[1];
    const nameHtml = match[2];
    const countStr = match[3];

    const href = unescapeHtml(hrefRaw);
    let name = stripHtmlTags(nameHtml).trim();
    const count = parseInt(countStr.replace(/,/g, ''), 10);

    if (!name) continue;

    let type = defaultType;

    if (href.includes('female:')) {
      type = 'female';
      name = name.replace(FEMALE_SUFFIX_RE, '');
    } else if (href.includes('male:')) {
      type = 'male';
      name = name.replace(MALE_SUFFIX_RE, '');
    } else if (name.endsWith('♂')) {
      type = 'male';
      name = name.replace(MALE_SUFFIX_RE, '');
    } else if (name.endsWith('♀')) {
      type = 'female';
      name = name.replace(FEMALE_SUFFIX_RE, '');
    }

    name = name.trim();
    if (!name) continue;

    tags.push({ name, count, type });
  }

  return tags;
}

/**
 * Extract navigation letter-page URLs from HTML (e.g. ['allartists-b.html', 'allartists-c.html', ...])
 */
export function parseNavUrls(html: string): string[] {
  const navMatch = NAV_RE.exec(html);
  if (!navMatch) return [];

  const navBlock = navMatch[0];
  const seen = new Set<string>();
  const hrefs: string[] = [];

  // Reset lastIndex since HREF_RE is a module-level regex with /g flag
  HREF_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = HREF_RE.exec(navBlock)) !== null) {
    const href = match[1].replace(/^\//, '');
    if (!seen.has(href)) {
      seen.add(href);
      hrefs.push(href);
    }
  }

  return hrefs;
}
