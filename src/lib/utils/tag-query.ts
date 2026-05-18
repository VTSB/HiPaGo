import { TagType } from './types';
import { useTagI18nStore } from '@/lib/store/tag-i18n';
import { tagFromDisplay } from './hitomi-tag';

/**
 * Korean tag-search query layer.
 *
 * The search box, the `/search?q=` URL and recent searches keep the query in
 * the script the user typed (Korean stays Korean). English↔Korean translation
 * happens only at the nozomi execution boundary via `normalizeQueryToEnglish`.
 */

/** The 7 user-facing tag types that can carry a Korean type label. */
const SEARCHABLE_TYPES: TagType[] = [
  TagType.GROUP,
  TagType.ARTIST,
  TagType.SERIES,
  TagType.CHARACTER,
  TagType.TAG,
  TagType.MALE,
  TagType.FEMALE,
];

/** TagType → Korean type label. */
export const KOREAN_TYPE_LABEL: Record<TagType, string> = {
  [TagType.BEFORE]: '',
  [TagType.ID]: '',
  [TagType.TYPE]: '',
  [TagType.LANGUAGE]: '',
  [TagType.GROUP]: '그룹',
  [TagType.ARTIST]: '작가',
  [TagType.SERIES]: '시리즈',
  [TagType.CHARACTER]: '캐릭터',
  [TagType.TAG]: '태그',
  [TagType.MALE]: '남자',
  [TagType.FEMALE]: '여자',
};

/** Korean type label → TagType (inverse of KOREAN_TYPE_LABEL for searchable types). */
export const KOREAN_LABEL_TO_TYPE: Record<string, TagType> = SEARCHABLE_TYPES.reduce(
  (acc, type) => {
    acc[KOREAN_TYPE_LABEL[type]] = type;
    return acc;
  },
  {} as Record<string, TagType>,
);

/** True when the string contains any Hangul syllable or jamo character. */
export function isHangul(s: string): boolean {
  // U+AC00-D7A3 syllables, U+1100-11FF jamo, U+3130-318F compatibility jamo.
  return /[가-힣ᄀ-ᇿ㄰-㆏]/.test(s);
}

/**
 * Build a Korean search-format token from a tag type and its Korean name.
 * Spaces in the Korean name are underscored so `parseCompoundQuery` (which
 * splits on whitespace) treats the token as a single term.
 *
 * Example: buildKoreanToken('female', '큰 가슴') → '여자:큰_가슴'
 */
export function buildKoreanToken(type: TagType, koreanName: string): string {
  const label = KOREAN_TYPE_LABEL[type] || '';
  const name = koreanName.trim().replace(/ /g, '_');
  return `${label}:${name}`;
}

/**
 * Convert a (possibly compound) query into a canonical English query.
 *
 * Per whitespace-separated term:
 *  - split on the first `:` into a type part and a name part;
 *  - a Korean type label maps to its TagType, an English type passes through;
 *  - if the name part is Hangul, reverse-resolve it (type-scoped when a type is
 *    known) to the English searchForm;
 *  - rebuild as `type:searchForm`.
 *
 * English terms pass through byte-identical. An unknown type prefix is treated
 * as a plain (typeless) term — the term is returned unchanged, matching the
 * current `parseQuery` behavior.
 */
export function normalizeQueryToEnglish(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return query;

  const i18n = useTagI18nStore.getState();

  const terms = trimmed.split(/\s+/).filter((t) => t.length > 0);
  const normalized = terms.map((term) => {
    // Preserve a leading '-' (negative term) and re-attach it after.
    const negative = term.startsWith('-') && term.length > 1;
    const body = negative ? term.slice(1) : term;

    const colonIdx = body.indexOf(':');
    if (colonIdx <= 0) {
      // Typeless term. Translate if the whole term is Hangul.
      if (isHangul(body)) {
        const match = i18n.reverseLookup(body.replace(/_/g, ' '));
        if (match) {
          const eng = `${match.type}:${tagFromDisplay(match.name, match.type as TagType).searchForm}`;
          return negative ? `-${eng}` : eng;
        }
      }
      return term;
    }

    const typePart = body.slice(0, colonIdx);
    const namePart = body.slice(colonIdx + 1);

    // Resolve the type: Korean label, or an English TagType, or unknown.
    let resolvedType: TagType | null = null;
    if (KOREAN_LABEL_TO_TYPE[typePart]) {
      resolvedType = KOREAN_LABEL_TO_TYPE[typePart];
    } else if ((Object.values(TagType) as string[]).includes(typePart.toLowerCase())) {
      resolvedType = typePart.toLowerCase() as TagType;
    }

    // Unknown type prefix → plain term, unchanged.
    if (!resolvedType) return term;

    // English name → pass through byte-identical (rebuild canonical type:name).
    if (!isHangul(namePart)) {
      const eng = `${resolvedType}:${namePart}`;
      return negative ? `-${eng}` : eng;
    }

    // Korean name → reverse-resolve (type-scoped) to the English searchForm.
    const match = i18n.reverseLookup(namePart.replace(/_/g, ' '), { type: resolvedType });
    if (!match) {
      // No translation found — leave the term as-is (nozomi returns empty).
      return term;
    }
    const eng = `${match.type}:${tagFromDisplay(match.name, match.type as TagType).searchForm}`;
    return negative ? `-${eng}` : eng;
  });

  return normalized.join(' ');
}
