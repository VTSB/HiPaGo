import { type TagType, TAG_TYPE_DISPLAY, type Suggestion } from './types';

/**
 * HitomiTag — 태그의 4가지 표현을 통합하는 Value Object
 *
 * - searchForm:  "big_breasts"      — underscore, URL/쿼리/tokenization용 (canonical)
 * - displayForm: "big breasts"      — spaces, 순수 영문 표시용
 * - uiForm:      "big breasts ♀"    — hitomi UI 표시 (♀/♂ 포함)
 * - localForm:   "큰 가슴" | null    — 한국어 로컬라이즈
 */
export interface HitomiTag {
  readonly searchForm: string;
  readonly displayForm: string;
  readonly uiForm: string;
  readonly localForm: string | null;
  readonly type: TagType;
  readonly count: number;
}

// ── Factory functions ──

/** searchForm (underscore) 기반으로 생성. URL 파싱, 쿼리 토큰 등에서 사용. */
export function tagFromSearch(
  searchForm: string,
  type: TagType,
  count: number = 0,
  localForm: string | null = null,
): HitomiTag {
  const displayForm = searchForm.replace(/_/g, ' ');
  const suffix = TAG_TYPE_DISPLAY[type] ?? '';
  return { searchForm, displayForm, uiForm: displayForm + suffix, localForm, type, count };
}

/** displayForm (spaces) 기반으로 생성. DB 결과, API 응답 등에서 사용. */
export function tagFromDisplay(
  displayForm: string,
  type: TagType,
  count: number = 0,
  localForm: string | null = null,
): HitomiTag {
  const searchForm = displayForm.replace(/ /g, '_');
  const suffix = TAG_TYPE_DISPLAY[type] ?? '';
  return { searchForm, displayForm, uiForm: displayForm + suffix, localForm, type, count };
}

/** Suggestion 객체에서 생성. autocomplete 결과 변환에 사용. */
export function tagFromSuggestion(suggestion: Suggestion): HitomiTag {
  return tagFromDisplay(
    suggestion.tag,
    suggestion.tagType,
    suggestion.amount,
    suggestion.localName ?? null,
  );
}

/** "female:big_breasts" 같은 qualified search string을 파싱하여 생성. */
export function tagFromQualified(qualified: string): HitomiTag | null {
  const colonIdx = qualified.indexOf(':');
  if (colonIdx <= 0) return null;
  const typePart = qualified.slice(0, colonIdx).toLowerCase();
  const tagPart = qualified.slice(colonIdx + 1);
  if (!tagPart) return null;
  const validTypes = ['artist', 'group', 'series', 'character', 'tag', 'male', 'female', 'type', 'language'];
  if (!validTypes.includes(typePart)) return null;
  return tagFromSearch(tagPart, typePart as TagType);
}

/** GalleryBlock.tags 엔트리에서 생성. name은 space 형태 (DB/parser 출력). */
export function tagFromGalleryEntry(type: TagType, name: string): HitomiTag {
  return tagFromDisplay(name, type);
}

// ── Utility functions ──

/** "female:big_breasts" — qualified search string */
export function toSearchString(tag: HitomiTag): string {
  return `${tag.type}:${tag.searchForm}`;
}

/** "female:big breasts" — qualified display string */
export function toDisplayString(tag: HitomiTag): string {
  return `${tag.type}:${tag.displayForm}`;
}

/** "female:big breasts ♀" — qualified UI string */
export function toUiString(tag: HitomiTag): string {
  return `${tag.type}:${tag.uiForm}`;
}

/** locale에 따른 표시 이름. ko + localForm 있으면 localForm, 아니면 displayForm */
export function getDisplayName(tag: HitomiTag, locale: string): string {
  if (locale === 'ko' && tag.localForm) return tag.localForm;
  return tag.displayForm;
}

/** 두 태그의 identity 비교 (type + searchForm) */
export function tagsEqual(a: HitomiTag, b: HitomiTag): boolean {
  return a.type === b.type && a.searchForm === b.searchForm;
}
