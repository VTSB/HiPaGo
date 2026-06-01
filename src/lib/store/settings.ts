import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_IMAGE_CACHE_MAX_BYTES } from '@/lib/cache/image-cache-store';

export type Locale = 'en' | 'ko';

interface SettingsStoreState {
  locale: Locale;
  language: string;
  theme: 'light' | 'dark';
  readerMode: 'page' | 'scroll';
  imageFormat: 'auto' | 'avif' | 'webp' | 'original';
  blurTags: string[];
  dualPage: boolean;
  gridColumns: number;
  /** Scroll-mode zoom scale. 1 = fit container width; >1 enlarges (pan), <1 shrinks. */
  scrollZoom: number;
  /** Max image-cache size in bytes. null = unlimited, 0 = off (no caching). */
  imageCacheMaxBytes: number | null;
  /** Base path for public downloads. null = platform default (Download/HiPaGo). */
  downloadBasePath: string | null;
  setLocale: (locale: Locale) => void;
  setLanguage: (language: string) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setReaderMode: (mode: 'page' | 'scroll') => void;
  setImageFormat: (format: 'auto' | 'avif' | 'webp' | 'original') => void;
  setDualPage: (dual: boolean) => void;
  setGridColumns: (cols: number) => void;
  setScrollZoom: (z: number) => void;
  setImageCacheMaxBytes: (bytes: number | null) => void;
  setDownloadBasePath: (path: string | null) => void;
  addBlurTag: (tag: string) => void;
  removeBlurTag: (tag: string) => void;
}

// furry/snuff/guro/scat each appear under BOTH the female: and male: hitomi
// namespaces, so both forms are listed to catch a gallery tagged under either.
const SAFETY_BLUR_TAGS = [
  'female:furry', 'male:furry',
  'female:snuff', 'male:snuff',
  'female:guro', 'male:guro',
  'female:scat', 'male:scat',
];
export const DEFAULT_BLUR_TAGS = ['male:yaoi', ...SAFETY_BLUR_TAGS];
// Safety tags added to the default blur filter in settings v1; merged once into
// an existing user's blurTags via the persist migration below.
const V1_ADDED_BLUR_TAGS = SAFETY_BLUR_TAGS;

/** Persist migration: union the v1 default safety tags into an existing user's
 *  blurTags (once, on the 0->1 bump). A tag the user later removes stays removed.
 *  Exported for unit tests. */
export function migrateSettings(persisted: unknown, version: number): unknown {
  if (!persisted || typeof persisted !== 'object') return persisted;
  let s = persisted as { blurTags?: string[]; imageCacheMaxBytes?: number | null; downloadBasePath?: string | null };
  // v1: union the safety blur tags once.
  if (version < 1) {
    const existing = Array.isArray(s.blurTags) ? s.blurTags : [];
    s = { ...s, blurTags: Array.from(new Set([...existing, ...V1_ADDED_BLUR_TAGS])) };
  }
  // v2: default the image-cache cap for existing users (additive).
  if (version < 2 && s.imageCacheMaxBytes === undefined) {
    s = { ...s, imageCacheMaxBytes: DEFAULT_IMAGE_CACHE_MAX_BYTES };
  }
  // v3: default the download base path for existing users (additive).
  if (version < 3 && s.downloadBasePath === undefined) {
    s = { ...s, downloadBasePath: null };
  }
  return s;
}

export const useSettingsStore = create<SettingsStoreState>()(
  persist(
    (set) => ({
      locale: 'en',
      language: 'all',
      theme: 'dark',
      readerMode: 'page',
      imageFormat: 'auto',
      blurTags: DEFAULT_BLUR_TAGS,
      dualPage: false,
      gridColumns: 0,
      scrollZoom: 1,
      imageCacheMaxBytes: DEFAULT_IMAGE_CACHE_MAX_BYTES,
      downloadBasePath: null,
      setLocale: (locale) => set({ locale }),
      setLanguage: (language) => set({ language }),
      setTheme: (theme) => set({ theme }),
      setReaderMode: (mode) => set({ readerMode: mode }),
      setImageFormat: (format) => set({ imageFormat: format }),
      setDualPage: (dual) => set({ dualPage: dual }),
      setGridColumns: (cols) => set({ gridColumns: cols }),
      setScrollZoom: (z) => set({ scrollZoom: z }),
      setImageCacheMaxBytes: (bytes) => set({ imageCacheMaxBytes: bytes }),
      setDownloadBasePath: (path) => set({ downloadBasePath: path }),
      addBlurTag: (tag) => set((s) => ({ blurTags: s.blurTags.includes(tag) ? s.blurTags : [...s.blurTags, tag] })),
      removeBlurTag: (tag) => set((s) => ({ blurTags: s.blurTags.filter((t) => t !== tag) })),
    }),
    { name: 'hipago-settings', version: 3, migrate: migrateSettings },
  ),
);

/** Detect browser locale and apply if this is the first visit (no persisted setting).
 *  Waits for Zustand persist hydration to avoid reading stale defaults. */
export function initLocaleOnce() {
  function applyAutoLocale() {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('hipago-settings') : null;
    if (!raw && typeof navigator !== 'undefined' && navigator.language.startsWith('ko')) {
      useSettingsStore.getState().setLocale('ko');
    }
  }

  if (useSettingsStore.persist.hasHydrated()) {
    applyAutoLocale();
  } else {
    useSettingsStore.persist.onFinishHydration(applyAutoLocale);
  }
}
