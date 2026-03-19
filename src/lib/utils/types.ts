export enum GalleryBlockType {
  FAILED = -1,
  LOADING = 0,
  DETAILED = 1,
  NOT_DETAILED = 2,
}

export type SortOrder = 'date_added' | 'popular_year' | 'popular_month' | 'popular_week' | 'popular_day';

export enum TagType {
  BEFORE = 'before',
  ID = 'id',
  TYPE = 'type',
  LANGUAGE = 'language',
  GROUP = 'group',
  ARTIST = 'artist',
  SERIES = 'series',
  CHARACTER = 'character',
  TAG = 'tag',
  MALE = 'male',
  FEMALE = 'female',
}

export const TAG_TYPE_DISPLAY: Record<TagType, string> = {
  [TagType.BEFORE]: '',
  [TagType.ID]: '',
  [TagType.TYPE]: '',
  [TagType.LANGUAGE]: '',
  [TagType.GROUP]: '',
  [TagType.ARTIST]: '',
  [TagType.SERIES]: '',
  [TagType.CHARACTER]: '',
  [TagType.TAG]: '',
  [TagType.MALE]: ' ♂',
  [TagType.FEMALE]: ' ♀',
};

/** Tailwind classes for tag chip colors by type */
export const TAG_TYPE_COLOR: Record<string, string> = {
  [TagType.FEMALE]: 'bg-pink-100 text-pink-700 hover:bg-pink-200 dark:bg-pink-900/40 dark:text-pink-300 dark:hover:bg-pink-800/50',
  [TagType.MALE]: 'bg-sky-100 text-sky-700 hover:bg-sky-200 dark:bg-sky-900/40 dark:text-sky-300 dark:hover:bg-sky-800/50',
};

const TAG_DEFAULT_COLOR = 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700';

export function getTagColor(type: string): string {
  return TAG_TYPE_COLOR[type] ?? TAG_DEFAULT_COLOR;
}

/** Byte mapping for DB storage (matches V3 Room enum explicit id values) */
export const TAG_TYPE_TO_BYTE: Record<TagType, number> = {
  [TagType.BEFORE]: 0,
  [TagType.ID]: 0,        // shares byte 0 with BEFORE (V3 design)
  [TagType.TYPE]: 1,
  [TagType.LANGUAGE]: 2,
  [TagType.GROUP]: 3,
  [TagType.ARTIST]: 4,
  [TagType.SERIES]: 5,
  [TagType.CHARACTER]: 6,
  [TagType.TAG]: 7,
  [TagType.MALE]: 8,
  [TagType.FEMALE]: 9,
};

/** Reverse mapping: byte → TagType (byte 0 defaults to BEFORE since ID is unused in practice) */
export const BYTE_TO_TAG_TYPE: Record<number, TagType> = {
  0: TagType.BEFORE,
  1: TagType.TYPE,
  2: TagType.LANGUAGE,
  3: TagType.GROUP,
  4: TagType.ARTIST,
  5: TagType.SERIES,
  6: TagType.CHARACTER,
  7: TagType.TAG,
  8: TagType.MALE,
  9: TagType.FEMALE,
};

export enum ImageType {
  ORIGINAL = 'original',
  WEBP = 'webp',
  AVIF = 'avif',
  AVIFSMALLTN = 'avifsmalltn',
}

export interface GalleryBlock {
  id: number;
  type: GalleryBlockType;
  title: string;
  date: Date;
  tags: Partial<Record<TagType, string[]>>;
  thumbnail: string;
  related: number[];
  language?: string;
  mediaType?: string;
  updatedAt?: Date;
}

export interface GalleryImage {
  name: string;
  hash: string;
  width: number;
  height: number;
  types: Set<ImageType>;
}

export interface GalleryImages {
  id: number;
  images: GalleryImage[];
}

export interface GalleryIds {
  idList: number[];
  length: number;
}

export interface Suggestion {
  tag: string;
  tagType: TagType;
  amount: number;
  localName?: string;
}

export interface GalleryInfo {
  languageLocalName: string;
  language: string;
  date: string;
  files: GalleryFile[];
  tags: GalleryTagJson[];
  artists: string[];
  groups: string[];
  characters: string[];
  parodys: string[];
  japaneseTitle: string;
  title: string;
  id: number;
  type: string;
  related: number[];
}

export interface GalleryFile {
  width: number;
  height: number;
  haswebp: number;
  hasavifsmalltn: number;
  hasavif: number;
  name: string;
  hash: string;
}

export interface GalleryTagJson {
  male: string;
  female: string;
  url: string;
  tag: string;
}

export interface TagWithAmount {
  tag: string;
  amount: number;
}

export interface IndexNode {
  keys: Uint8Array[];
  datas: IndexData[];
  subNodeAddresses: number[];
}

export interface IndexData {
  offset: number;
  length: number;
}

export interface GgConfig {
  pathCode: string;
  mDefault: number;
  mCases: Set<number>;
  mCaseValue: number;
}
