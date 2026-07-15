import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_IMAGE_CACHE_MAX_BYTES } from '@/lib/cache/image-cache-store';
import { SettingsBackup } from '@/lib/plugins/settingsBackup';
import { isAndroid } from '@/lib/utils/platform';

const SETTINGS_STORAGE_KEY = 'hipago-settings';

export type Locale = 'en' | 'ko';
export type LibraryInitialTab = 'favorites' | 'history' | 'downloads';

interface SettingsStoreState {
  locale: Locale;
  language: string;
  theme: 'light' | 'dark';
  readerMode: 'page' | 'scroll';
  imageFormat: 'auto' | 'avif' | 'webp' | 'original';
  blurTags: string[];
  /** Search-query syntax applied to every list/search result set. */
  defaultFilterQuery: string;
  /** Android-only: hide app content from recent-app previews. */
  secureScreen: boolean;
  /** Mobile library hub tab to open when /library has no explicit tab query. */
  libraryInitialTab: LibraryInitialTab;
  dualPage: boolean;
  gridColumns: number;
  /** Scroll-mode zoom scale. 1 = fit container width; >1 enlarges (pan), <1 shrinks. */
  scrollZoom: number;
  /** Max image-cache size in bytes. null = unlimited, 0 = off (no caching). */
  imageCacheMaxBytes: number | null;
  /**
   * SAF tree URI for the user-picked download folder (content://…). null = no
   * folder chosen yet (the first download prompts the picker). This mirrors the
   * native persisted permission so the settings UI can show the chosen folder.
   */
  downloadTreeUri: string | null;
  /** Display name of the chosen download folder, for the settings UI. */
  downloadTreeName: string | null;
  setLocale: (locale: Locale) => void;
  setLanguage: (language: string) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setReaderMode: (mode: 'page' | 'scroll') => void;
  setImageFormat: (format: 'auto' | 'avif' | 'webp' | 'original') => void;
  setDefaultFilterQuery: (query: string) => void;
  setSecureScreen: (enabled: boolean) => void;
  setLibraryInitialTab: (tab: LibraryInitialTab) => void;
  setDualPage: (dual: boolean) => void;
  setGridColumns: (cols: number) => void;
  setScrollZoom: (z: number) => void;
  setImageCacheMaxBytes: (bytes: number | null) => void;
  setDownloadTree: (uri: string | null, name: string | null) => void;
  addBlurTag: (tag: string) => void;
  removeBlurTag: (tag: string) => void;
}

// furry/snuff/guro/scat each appear under BOTH the female: and male: hitomi
// namespaces, so both forms are listed to catch a gallery tagged under either.
const SAFETY_BLUR_TAGS = [
  'female:furry',
  'male:furry',
  'female:snuff',
  'male:snuff',
  'female:guro',
  'male:guro',
  'female:scat',
  'male:scat',
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
  let s = persisted as {
    blurTags?: string[];
    imageCacheMaxBytes?: number | null;
    defaultFilterQuery?: string;
    secureScreen?: boolean;
    libraryInitialTab?: LibraryInitialTab;
    downloadBasePath?: string | null;
    downloadTreeUri?: string | null;
    downloadTreeName?: string | null;
  };
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
  // v4: downloads moved from absolute-path base to a SAF tree URI. The old
  // downloadBasePath was always an absolute filesystem path, never a content://
  // URI, so it cannot be reused — drop it and start with no folder chosen
  // (the first download re-prompts the SAF picker).
  if (version < 4) {
    const next = { ...s, downloadTreeUri: null, downloadTreeName: null } as typeof s;
    delete next.downloadBasePath;
    s = next;
  }
  // v5: default result filter query. Empty means disabled.
  if (version < 5 && s.defaultFilterQuery === undefined) {
    s = { ...s, defaultFilterQuery: '' };
  }
  // v6: Android recent-app preview protection. Default enabled for existing
  // users as well, so the secure-screen protection applies by default.
  if (version < 6 && s.secureScreen === undefined) {
    s = { ...s, secureScreen: true };
  }
  // v7: mobile Library hub default tab. Preserve old behavior for existing
  // users by defaulting to Favorites.
  if (version < 7 && s.libraryInitialTab === undefined) {
    s = { ...s, libraryInitialTab: 'favorites' };
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
      defaultFilterQuery: '',
      secureScreen: true,
      libraryInitialTab: 'favorites',
      dualPage: false,
      gridColumns: 0,
      scrollZoom: 1,
      imageCacheMaxBytes: DEFAULT_IMAGE_CACHE_MAX_BYTES,
      downloadTreeUri: null,
      downloadTreeName: null,
      setLocale: (locale) => set({ locale }),
      setLanguage: (language) => set({ language }),
      setTheme: (theme) => set({ theme }),
      setReaderMode: (mode) => set({ readerMode: mode }),
      setImageFormat: (format) => set({ imageFormat: format }),
      setDefaultFilterQuery: (query) => set({ defaultFilterQuery: query }),
      setSecureScreen: (enabled) => set({ secureScreen: enabled }),
      setLibraryInitialTab: (tab) => set({ libraryInitialTab: tab }),
      setDualPage: (dual) => set({ dualPage: dual }),
      setGridColumns: (cols) => set({ gridColumns: cols }),
      setScrollZoom: (z) => set({ scrollZoom: z }),
      setImageCacheMaxBytes: (bytes) => set({ imageCacheMaxBytes: bytes }),
      setDownloadTree: (uri, name) => set({ downloadTreeUri: uri, downloadTreeName: name }),
      addBlurTag: (tag) =>
        set((s) => ({ blurTags: s.blurTags.includes(tag) ? s.blurTags : [...s.blurTags, tag] })),
      removeBlurTag: (tag) => set((s) => ({ blurTags: s.blurTags.filter((t) => t !== tag) })),
    }),
    { name: SETTINGS_STORAGE_KEY, version: 7, migrate: migrateSettings },
  ),
);

let settingsPersistenceInit: Promise<void> | null = null;
let nativeBackupTimer: ReturnType<typeof setTimeout> | null = null;

function validPersistedSettings(raw: string | null): raw is string {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { state?: unknown; version?: unknown };
    return (
      !!parsed &&
      typeof parsed === 'object' &&
      !!parsed.state &&
      typeof parsed.state === 'object' &&
      (parsed.version === undefined || typeof parsed.version === 'number')
    );
  } catch {
    return false;
  }
}

async function mirrorSettingsToNative(): Promise<void> {
  if (!isAndroid() || typeof localStorage === 'undefined') return;
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!validPersistedSettings(raw)) return;
  await SettingsBackup.set({ value: raw });
}

/**
 * Restore settings after Android WebView storage loss, then mirror future
 * Zustand changes into native SharedPreferences. Local storage wins when both
 * copies exist because it contains the newest synchronous write.
 */
export function initializeSettingsPersistence(): Promise<void> {
  if (settingsPersistenceInit) return settingsPersistenceInit;
  settingsPersistenceInit = (async () => {
    if (!isAndroid() || typeof localStorage === 'undefined') return;

    let local = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (local && !validPersistedSettings(local)) {
      localStorage.removeItem(SETTINGS_STORAGE_KEY);
      local = null;
    }

    if (!local) {
      const native = await SettingsBackup.get().catch(() => ({ value: null }));
      if (validPersistedSettings(native.value)) {
        localStorage.setItem(SETTINGS_STORAGE_KEY, native.value);
        await useSettingsStore.persist.rehydrate();
        local = native.value;
      } else if (native.value) {
        await SettingsBackup.clear().catch(() => {});
      }
    }

    if (local) await SettingsBackup.set({ value: local }).catch(() => {});

    useSettingsStore.subscribe(() => {
      if (nativeBackupTimer) clearTimeout(nativeBackupTimer);
      nativeBackupTimer = setTimeout(() => {
        nativeBackupTimer = null;
        void mirrorSettingsToNative().catch(() => {});
      }, 250);
    });
  })();
  return settingsPersistenceInit;
}

/** Detect browser locale and apply if this is the first visit (no persisted setting).
 *  Waits for Zustand persist hydration to avoid reading stale defaults. */
export function initLocaleOnce() {
  function applyAutoLocale() {
    const raw =
      typeof localStorage !== 'undefined' ? localStorage.getItem(SETTINGS_STORAGE_KEY) : null;
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
