import { create } from 'zustand';
import { getChoseong, disassemble } from 'es-hangul';

// JSON file format: { [type: string]: { [name: string]: localizedString } }
type I18nJson = Record<string, Record<string, string>>;

/** Pre-computed search index entry */
interface SearchEntry {
  key: string; // "type:name"
  type: string;
  name: string;
  local: string; // original localized string
  disassembled: string; // pre-computed disassemble(local) for jamo matching
  choseong: string; // pre-computed getChoseong(local) with spaces stripped
}

interface TagI18nState {
  /** Map from "type:name" → localized string */
  nameToLocal: Map<string, string>;
  /** Map from localized string → array of "type:name" keys */
  localToNames: Map<string, string[]>;
  /** Pre-computed search index for fast Korean matching */
  searchIndex: SearchEntry[];
  /** True once loadLocale has completed (even if no translations were found) */
  isLoaded: boolean;
  /** Locale code for the currently loaded translation maps */
  loadedLocale: string | null;
  loadLocale: (lang: string) => Promise<void>;
  getLocal: (type: string, name: string) => string | undefined;
  searchByLocal: (
    query: string,
    options?: { type?: string },
  ) => Array<{ type: string; name: string; local: string }>;
}

export function getTagI18nLookupKeys(type: string, name: string): string[] {
  const rawName = name.trim();
  const normalizedName = name.replace(/_/g, ' ').trim();
  let resolvedType = type;
  let resolvedName = normalizedName;

  if (type === 'tag') {
    if (normalizedName.endsWith(' ♂')) {
      resolvedType = 'male';
      resolvedName = normalizedName.slice(0, -2).trim();
    } else if (normalizedName.endsWith(' ♀')) {
      resolvedType = 'female';
      resolvedName = normalizedName.slice(0, -2).trim();
    }
  }

  const candidates = [`${resolvedType}:${resolvedName}`, `${type}:${normalizedName}`];

  if (rawName !== normalizedName) {
    candidates.push(`${resolvedType}:${rawName}`);
    candidates.push(`${type}:${rawName}`);
  }

  const lowerResolvedName = resolvedName.toLowerCase();
  const lowerNormalizedName = normalizedName.toLowerCase();
  const lowerRawName = rawName.toLowerCase();
  candidates.push(`${resolvedType}:${lowerResolvedName}`);
  candidates.push(`${type}:${lowerNormalizedName}`);

  if (lowerRawName !== lowerNormalizedName) {
    candidates.push(`${resolvedType}:${lowerRawName}`);
    candidates.push(`${type}:${lowerRawName}`);
  }

  if (resolvedType === 'type') {
    candidates.push(`${resolvedType}:${lowerResolvedName.replace(/ /g, '')}`);
  }

  if (resolvedType === 'male' || resolvedType === 'female') {
    candidates.push(`tag:${resolvedName}`);
    candidates.push(`tag:${lowerResolvedName}`);
  }

  return [...new Set(candidates)];
}

// Static import map — Next.js needs deterministic paths at build time.
const JSON_LOADERS: Record<string, () => Promise<{ default: I18nJson }>> = {
  ko: () => import('@/lib/data/tags-i18n/ko.json'),
  'ko.ai': () => import('@/lib/data/tags-i18n/ko.ai.json'),
  ja: () => import('@/lib/data/tags-i18n/ja.json'),
  'ja.ai': () => import('@/lib/data/tags-i18n/ja.ai.json'),
  'zh-Hans': () => import('@/lib/data/tags-i18n/zh-Hans.json'),
  'zh-Hans.ai': () => import('@/lib/data/tags-i18n/zh-Hans.ai.json'),
  'zh-Hant': () => import('@/lib/data/tags-i18n/zh-Hant.json'),
  'zh-Hant.ai': () => import('@/lib/data/tags-i18n/zh-Hant.ai.json'),
};

async function importJson(lang: string, suffix: string): Promise<I18nJson | null> {
  const key = `${lang}${suffix}`;
  const loader = JSON_LOADERS[key];
  if (!loader) return null;
  try {
    const mod = await loader();
    return (mod.default ?? mod) as I18nJson;
  } catch {
    return null;
  }
}

function buildMaps(data: I18nJson): {
  nameToLocal: Map<string, string>;
  localToNames: Map<string, string[]>;
  searchIndex: SearchEntry[];
} {
  const nameToLocal = new Map<string, string>();
  const localToNames = new Map<string, string[]>();
  const searchIndex: SearchEntry[] = [];

  for (const [type, names] of Object.entries(data)) {
    for (const [name, local] of Object.entries(names)) {
      const key = `${type}:${name}`;
      nameToLocal.set(key, local);

      const existing = localToNames.get(local);
      if (existing) {
        existing.push(key);
      } else {
        localToNames.set(local, [key]);
      }

      // Pre-compute search data (one-time cost at load)
      searchIndex.push({
        key,
        type,
        name,
        local,
        disassembled: disassemble(local),
        choseong: getChoseong(local).replace(/ /g, ''),
      });
    }
  }

  return { nameToLocal, localToNames, searchIndex };
}

function mergeI18nData(manual: I18nJson, ai: I18nJson): I18nJson {
  const merged: I18nJson = {};

  for (const [type, names] of Object.entries(manual)) {
    merged[type] = { ...names };
  }

  for (const [type, names] of Object.entries(ai)) {
    if (!merged[type]) {
      merged[type] = {};
    }
    for (const [name, local] of Object.entries(names)) {
      if (!(name in merged[type])) {
        merged[type][name] = local;
      }
    }
  }

  return merged;
}

export function createTagI18nStore() {
  return create<TagI18nState>()((set, get) => ({
    nameToLocal: new Map(),
    localToNames: new Map(),
    searchIndex: [],
    isLoaded: false,
    loadedLocale: null,

    async loadLocale(lang: string) {
      const [manualData, aiData] = await Promise.all([
        importJson(lang, ''),
        importJson(lang, '.ai'),
      ]);

      if (!manualData && !aiData) {
        set({
          nameToLocal: new Map(),
          localToNames: new Map(),
          searchIndex: [],
          isLoaded: true,
          loadedLocale: lang,
        });
        return;
      }

      const merged = mergeI18nData(manualData ?? {}, aiData ?? {});
      const { nameToLocal, localToNames, searchIndex } = buildMaps(merged);

      set({ nameToLocal, localToNames, searchIndex, isLoaded: true, loadedLocale: lang });
    },

    getLocal(type: string, name: string): string | undefined {
      const { nameToLocal } = get();
      for (const key of getTagI18nLookupKeys(type, name)) {
        const local = nameToLocal.get(key);
        if (local !== undefined) return local;
      }
      return undefined;
    },

    searchByLocal(
      query: string,
      options?: { type?: string },
    ): Array<{ type: string; name: string; local: string }> {
      const { searchIndex } = get();
      const typeFilter = options?.type;

      // Pre-compute query transformations once (not per entry)
      const isChosung = query.length > 0 && [...query].every((ch) => /^[ㄱ-ㅎ]$/.test(ch));
      const queryDisassembled = disassemble(query);

      const seen = new Set<string>();
      const results: Array<{ type: string; name: string; local: string }> = [];

      for (const entry of searchIndex) {
        if (typeFilter && entry.type !== typeFilter) continue;

        const isMatch =
          entry.local.startsWith(query) ||
          (isChosung && entry.choseong.startsWith(query)) ||
          entry.disassembled.startsWith(queryDisassembled);

        if (isMatch && !seen.has(entry.key)) {
          seen.add(entry.key);
          results.push({ type: entry.type, name: entry.name, local: entry.local });
        }
      }

      return results;
    },
  }));
}

// Singleton store instance
export const useTagI18nStore = createTagI18nStore();
