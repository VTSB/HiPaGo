import { create } from 'zustand';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getChoseong } from 'es-hangul';

// JSON file format: { [type: string]: { [name: string]: localizedString } }
type I18nJson = Record<string, Record<string, string>>;

interface TagI18nState {
  /** Map from "type:name" → localized string */
  nameToLocal: Map<string, string>;
  /** Map from localized string → array of "type:name" keys */
  localToNames: Map<string, string[]>;
  /** True once loadLocale has completed (even if no translations were found) */
  isLoaded: boolean;
  loadLocale: (lang: string) => Promise<void>;
  getLocal: (type: string, name: string) => string | undefined;
  searchByLocal: (
    query: string,
    options?: { type?: string },
  ) => Array<{ type: string; name: string; local: string }>;
}

function dataDir(): string {
  return path.resolve(process.cwd(), 'src/lib/data/tags-i18n');
}

async function readJsonFile(filePath: string): Promise<I18nJson | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as I18nJson;
  } catch {
    return null;
  }
}

function buildMaps(data: I18nJson): {
  nameToLocal: Map<string, string>;
  localToNames: Map<string, string[]>;
} {
  const nameToLocal = new Map<string, string>();
  const localToNames = new Map<string, string[]>();

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
    }
  }

  return { nameToLocal, localToNames };
}

function mergeI18nData(manual: I18nJson, ai: I18nJson): I18nJson {
  const merged: I18nJson = {};

  // Start with all manual entries
  for (const [type, names] of Object.entries(manual)) {
    merged[type] = { ...names };
  }

  // Add AI entries only for keys not already in manual
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
    isLoaded: false,

    async loadLocale(lang: string) {
      const dir = dataDir();
      const manualPath = path.join(dir, `${lang}.json`);
      const aiPath = path.join(dir, `${lang}.ai.json`);

      const [manualData, aiData] = await Promise.all([
        readJsonFile(manualPath),
        readJsonFile(aiPath),
      ]);

      if (!manualData && !aiData) {
        set({ isLoaded: true });
        return;
      }

      const merged = mergeI18nData(manualData ?? {}, aiData ?? {});
      const { nameToLocal, localToNames } = buildMaps(merged);

      set({ nameToLocal, localToNames, isLoaded: true });
    },

    getLocal(type: string, name: string): string | undefined {
      return get().nameToLocal.get(`${type}:${name}`);
    },

    searchByLocal(
      query: string,
      options?: { type?: string },
    ): Array<{ type: string; name: string; local: string }> {
      const { nameToLocal } = get();
      const typeFilter = options?.type;

      const seen = new Set<string>();
      const results: Array<{ type: string; name: string; local: string }> = [];

      for (const [key, local] of nameToLocal.entries()) {
        const colonIdx = key.indexOf(':');
        const entryType = key.slice(0, colonIdx);
        const entryName = key.slice(colonIdx + 1);

        if (typeFilter && entryType !== typeFilter) continue;

        const isChosung = query.length > 0 && [...query].every((ch) => /^[ㄱ-ㅎ]$/.test(ch));
        const isMatch =
          local.startsWith(query) ||
          (isChosung && getChoseong(local).startsWith(query));

        if (isMatch && !seen.has(key)) {
          seen.add(key);
          results.push({ type: entryType, name: entryName, local });
        }
      }

      return results;
    },
  }));
}

// Singleton store instance
export const useTagI18nStore = createTagI18nStore();
