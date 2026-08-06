import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_IMAGE_CACHE_MAX_BYTES } from '@/lib/cache/image-cache-store';
import { SettingsBackup } from '@/lib/plugins/settingsBackup';
import { isAndroid } from '@/lib/utils/platform';

const SETTINGS_STORAGE_KEY = 'hipago-settings';
const SETTINGS_NATIVE_RESTORE_PENDING_KEY = 'hipago-settings-native-restore-pending';
const SETTINGS_NATIVE_RESTORE_MARKER_VERSION = 1;

export type Locale = 'en' | 'ko';
export type LibraryInitialTab = 'favorites' | 'history' | 'downloads';

/**
 * Whether this installation already had local settings when the client bundle
 * first loaded. Capture this before initLocaleOnce or a folder selection can
 * persist defaults, so a reinstall remains distinguishable during backup
 * restoration.
 */
export const hadPersistedSettingsAtBoot = (() => {
  try {
    if (typeof localStorage === 'undefined') return false;
    const raw = localStorage.getItem('hipago-settings');
    if (!raw) return false;
    const parsed = JSON.parse(raw) as unknown;
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      'state' in parsed &&
      typeof parsed.state === 'object' &&
      parsed.state !== null
    );
  } catch {
    return false;
  }
})();

export interface SettingsStoreState {
  locale: Locale;
  language: string;
  theme: 'light' | 'dark';
  readerMode: 'page' | 'scroll';
  imageFormat: 'auto' | 'avif' | 'webp' | 'original';
  blurTags: string[];
  favoriteTags: string[];
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
  restoreDownloadTreeFromNative: (uri: string | null, name: string | null) => void;
  addBlurTag: (tag: string) => void;
  removeBlurTag: (tag: string) => void;
  addFavoriteTag: (tag: string) => void;
  removeFavoriteTag: (tag: string) => void;
  toggleFavoriteTag: (tag: string) => void;
}

const PERSISTED_SETTINGS_FIELDS = new Set([
  'locale',
  'language',
  'theme',
  'readerMode',
  'imageFormat',
  'blurTags',
  'favoriteTags',
  'defaultFilterQuery',
  'secureScreen',
  'libraryInitialTab',
  'dualPage',
  'gridColumns',
  'scrollZoom',
  'imageCacheMaxBytes',
  'downloadTreeUri',
  'downloadTreeName',
]);

function isPersistedSettingsField(field: unknown): field is string {
  return typeof field === 'string' && PERSISTED_SETTINGS_FIELDS.has(field);
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
    favoriteTags?: string[];
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
  // v8: metadata favorites are persisted as canonical type:name keys.
  if (version < 8 && !Array.isArray(s.favoriteTags)) {
    s = { ...s, favoriteTags: [] };
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
      favoriteTags: [],
      defaultFilterQuery: '',
      secureScreen: true,
      libraryInitialTab: 'favorites',
      dualPage: false,
      gridColumns: 0,
      scrollZoom: 1,
      imageCacheMaxBytes: DEFAULT_IMAGE_CACHE_MAX_BYTES,
      downloadTreeUri: null,
      downloadTreeName: null,
      setLocale: (locale) => {
        markPendingRestoreLocalFields(['locale']);
        set({ locale });
      },
      setLanguage: (language) => {
        markPendingRestoreLocalFields(['language']);
        set({ language });
      },
      setTheme: (theme) => {
        markPendingRestoreLocalFields(['theme']);
        set({ theme });
      },
      setReaderMode: (mode) => {
        markPendingRestoreLocalFields(['readerMode']);
        set({ readerMode: mode });
      },
      setImageFormat: (format) => {
        markPendingRestoreLocalFields(['imageFormat']);
        set({ imageFormat: format });
      },
      setDefaultFilterQuery: (query) => {
        markPendingRestoreLocalFields(['defaultFilterQuery']);
        set({ defaultFilterQuery: query });
      },
      setSecureScreen: (enabled) => {
        markPendingRestoreLocalFields(['secureScreen']);
        set({ secureScreen: enabled });
      },
      setLibraryInitialTab: (tab) => {
        markPendingRestoreLocalFields(['libraryInitialTab']);
        set({ libraryInitialTab: tab });
      },
      setDualPage: (dual) => {
        markPendingRestoreLocalFields(['dualPage']);
        set({ dualPage: dual });
      },
      setGridColumns: (cols) => {
        markPendingRestoreLocalFields(['gridColumns']);
        set({ gridColumns: cols });
      },
      setScrollZoom: (z) => {
        markPendingRestoreLocalFields(['scrollZoom']);
        set({ scrollZoom: z });
      },
      setImageCacheMaxBytes: (bytes) => {
        markPendingRestoreLocalFields(['imageCacheMaxBytes']);
        set({ imageCacheMaxBytes: bytes });
      },
      setDownloadTree: (uri, name) => {
        markPendingRestoreLocalFields(['downloadTreeUri', 'downloadTreeName']);
        set({ downloadTreeUri: uri, downloadTreeName: name });
      },
      restoreDownloadTreeFromNative: (uri, name) => {
        // The persisted SAF grant is authoritative for these two fields, but
        // must not make unrelated default settings beat the native backup.
        markPendingRestoreLocalFields(['downloadTreeUri', 'downloadTreeName']);
        set({ downloadTreeUri: uri, downloadTreeName: name });
      },
      addBlurTag: (tag) =>
        set((s) => {
          markPendingRestoreLocalFields(['blurTags']);
          return { blurTags: s.blurTags.includes(tag) ? s.blurTags : [...s.blurTags, tag] };
        }),
      removeBlurTag: (tag) =>
        set((s) => {
          markPendingRestoreLocalFields(['blurTags']);
          return { blurTags: s.blurTags.filter((t) => t !== tag) };
        }),
      addFavoriteTag: (tag) =>
        set((s) => {
          markPendingRestoreLocalFields(['favoriteTags']);
          return {
            favoriteTags: s.favoriteTags.includes(tag) ? s.favoriteTags : [...s.favoriteTags, tag],
          };
        }),
      removeFavoriteTag: (tag) =>
        set((s) => {
          markPendingRestoreLocalFields(['favoriteTags']);
          return { favoriteTags: s.favoriteTags.filter((t) => t !== tag) };
        }),
      toggleFavoriteTag: (tag) =>
        set((s) => {
          markPendingRestoreLocalFields(['favoriteTags']);
          return {
            favoriteTags: s.favoriteTags.includes(tag)
              ? s.favoriteTags.filter((t) => t !== tag)
              : [...s.favoriteTags, tag],
          };
        }),
    }),
    { name: SETTINGS_STORAGE_KEY, version: 8, migrate: migrateSettings },
  ),
);

/** Apply a verified public-tree settings snapshot during startup recovery. */
export function restoreSettingsFromPublicBackup(
  settings: Partial<SettingsStoreState>,
  options: { authoritative?: boolean } = {},
): boolean {
  const marker =
    typeof localStorage !== 'undefined'
      ? readNativeRestoreMarker(localStorage.getItem(SETTINGS_NATIVE_RESTORE_PENDING_KEY))
      : null;
  if (!marker) {
    if (!options.authoritative && settingsPersistenceResolvedWithValue) return false;
    useSettingsStore.setState(settings);
    return true;
  }

  const sourceFields = Object.keys(settings).filter(isPersistedSettingsField);
  const nextSettings = { ...settings } as Record<string, unknown>;
  let localWins = marker.localWins;
  if (options.authoritative) {
    // An explicit user-requested public restore owns every supplied field.
    localWins = Array.from(new Set([...localWins, ...sourceFields]));
  } else {
    // Startup public restore is a fallback behind SharedPreferences. Preserve
    // only fields already changed by the live user while the public scan ran;
    // native retry may replace every other public field.
    const current = useSettingsStore.getState() as unknown as Record<string, unknown>;
    for (const field of localWins) {
      if (Object.prototype.hasOwnProperty.call(current, field)) {
        nextSettings[field] = current[field];
      }
    }
  }

  useSettingsStore.setState(nextSettings as Partial<SettingsStoreState>);
  const restoredRaw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (validPersistedSettings(restoredRaw)) {
    // The implicit public snapshot is now the system baseline. A subsequent
    // native retry merges only the recorded live-user fields over native.
    if (nativeRestoreLocalBaseline) nativeRestoreLocalBaseline.value = restoredRaw;
    else nativeRestoreLocalBaseline = { value: restoredRaw };
    writeNativeRestoreMarker(restoredRaw, localWins);
  }
  return true;
}

let settingsPersistenceInit: Promise<void> | null = null;
let nativeBackupTimer: ReturnType<typeof setTimeout> | null = null;
let nativeBackupReadPending = false;
let nativeMirrorEnabled = false;
let nativeRestoreLocalBaseline: { value: string | null } | null = null;
let settingsPersistenceResolvedWithValue = false;
let nativeSettingsWriteRunning = false;
type NativeSettingsWrite = {
  value: string;
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
};
let pendingNativeSettingsWrite: NativeSettingsWrite | null = null;
let activeNativeSettingsWrite: NativeSettingsWrite | null = null;
let lastCompletedNativeSettingsValue: string | null = null;

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

type NativeRestoreMarker = {
  baselineKnown: boolean;
  localBaseline: string | null;
  localWins: string[];
};

function readNativeRestoreMarker(raw: string | null): NativeRestoreMarker | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      localBaseline?: unknown;
      localWins?: unknown;
    };
    if (
      parsed?.version === SETTINGS_NATIVE_RESTORE_MARKER_VERSION &&
      (parsed.localBaseline === null || typeof parsed.localBaseline === 'string')
    ) {
      return {
        baselineKnown: true,
        localBaseline: parsed.localBaseline,
        localWins: Array.isArray(parsed.localWins)
          ? parsed.localWins.filter(isPersistedSettingsField)
          : [],
      };
    }
  } catch {
    // Legacy marker `1` and malformed markers have no recoverable baseline.
  }
  return { baselineKnown: false, localBaseline: null, localWins: [] };
}

function writeNativeRestoreMarker(localBaseline: string | null, localWins: string[] = []): void {
  localStorage.setItem(
    SETTINGS_NATIVE_RESTORE_PENDING_KEY,
    JSON.stringify({
      version: SETTINGS_NATIVE_RESTORE_MARKER_VERSION,
      localBaseline,
      localWins,
    }),
  );
}

function markPendingRestoreLocalFields(fields: string[]): void {
  if (typeof localStorage === 'undefined') return;
  const marker = readNativeRestoreMarker(
    localStorage.getItem(SETTINGS_NATIVE_RESTORE_PENDING_KEY),
  );
  if (!marker) return;

  const localBaseline = marker.baselineKnown
    ? marker.localBaseline
    : (nativeRestoreLocalBaseline?.value ?? localStorage.getItem(SETTINGS_STORAGE_KEY));
  writeNativeRestoreMarker(
    localBaseline,
    Array.from(new Set([...marker.localWins, ...fields.filter(isPersistedSettingsField)])),
  );
}

function mergeNativeSettingsWithLocalFields(
  nativeRaw: string,
  localRaw: string,
  localWins: string[],
): string {
  const nativeEnvelope = JSON.parse(nativeRaw) as {
    state: Record<string, unknown>;
    version?: unknown;
    [key: string]: unknown;
  };
  const localEnvelope = JSON.parse(localRaw) as {
    state: Record<string, unknown>;
    version?: unknown;
  };
  const mergedState = { ...nativeEnvelope.state };
  for (const field of localWins) {
    if (Object.prototype.hasOwnProperty.call(localEnvelope.state, field)) {
      mergedState[field] = localEnvelope.state[field];
    }
  }
  return JSON.stringify({ ...nativeEnvelope, state: mergedState });
}

async function runNativeSettingsWriteLane(): Promise<void> {
  if (nativeSettingsWriteRunning) return;
  nativeSettingsWriteRunning = true;
  try {
    while (pendingNativeSettingsWrite) {
      const write = pendingNativeSettingsWrite;
      pendingNativeSettingsWrite = null;
      activeNativeSettingsWrite = write;
      try {
        await SettingsBackup.set({ value: write.value });
        lastCompletedNativeSettingsValue = write.value;
        for (const waiter of write.waiters) waiter.resolve();
      } catch (error) {
        for (const waiter of write.waiters) waiter.reject(error);
      } finally {
        activeNativeSettingsWrite = null;
      }
    }
  } finally {
    nativeSettingsWriteRunning = false;
  }
}

function enqueueNativeSettingsWrite(value: string): Promise<void> {
  const promise = new Promise<void>((resolve, reject) => {
    if (
      !activeNativeSettingsWrite &&
      !pendingNativeSettingsWrite &&
      lastCompletedNativeSettingsValue === value
    ) {
      resolve();
    } else if (activeNativeSettingsWrite?.value === value) {
      if (pendingNativeSettingsWrite) {
        activeNativeSettingsWrite.waiters.push(...pendingNativeSettingsWrite.waiters);
        pendingNativeSettingsWrite = null;
      }
      activeNativeSettingsWrite.waiters.push({ resolve, reject });
    } else if (pendingNativeSettingsWrite) {
      // A newer full snapshot supersedes the queued one. All callers complete
      // when that latest snapshot is durably handed to the native plugin.
      pendingNativeSettingsWrite.value = value;
      pendingNativeSettingsWrite.waiters.push({ resolve, reject });
    } else {
      pendingNativeSettingsWrite = { value, waiters: [{ resolve, reject }] };
    }
  });
  void runNativeSettingsWriteLane();
  return promise;
}

async function mirrorSettingsToNative(): Promise<void> {
  if (!nativeMirrorEnabled || !isAndroid() || typeof localStorage === 'undefined') return;
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!validPersistedSettings(raw)) return;
  await enqueueNativeSettingsWrite(raw);
}

/**
 * Restore settings after Android WebView storage loss, then mirror future
 * Zustand changes into native SharedPreferences. A pending marker retries a
 * failed native read, while an exact local baseline prevents that retry from
 * overwriting settings the user changed after the first failure.
 */
export function initializeSettingsPersistence(): Promise<void> {
  if (settingsPersistenceInit) return settingsPersistenceInit;

  const initPromise = (async () => {
    if (!isAndroid() || typeof localStorage === 'undefined') return;

    let local = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (local && !validPersistedSettings(local)) {
      localStorage.removeItem(SETTINGS_STORAGE_KEY);
      local = null;
    }

    const restoreMarker = readNativeRestoreMarker(
      localStorage.getItem(SETTINGS_NATIVE_RESTORE_PENDING_KEY),
    );
    const restoreWasPending = restoreMarker !== null;
    if (!local || nativeBackupReadPending || restoreWasPending) {
      // Keep the exact local value observed by the first restore attempt. If
      // the live app writes a different valid value before a retry succeeds,
      // that user-visible change must win over an older native backup.
      const restoreLocalBaseline = (nativeRestoreLocalBaseline ??= {
        value: restoreMarker?.baselineKnown ? restoreMarker.localBaseline : local,
      });
      nativeBackupReadPending = true;
      writeNativeRestoreMarker(restoreLocalBaseline.value, restoreMarker?.localWins ?? []);

      // A rejected plugin read is not equivalent to an explicit empty backup.
      // Keep the marker and reject so a later call must retry the native read.
      const native = await SettingsBackup.get();
      let latestLocal = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (latestLocal && !validPersistedSettings(latestLocal)) {
        localStorage.removeItem(SETTINGS_STORAGE_KEY);
        latestLocal = null;
      }
      const localChangedSinceRestoreStarted =
        validPersistedSettings(latestLocal) &&
        latestLocal !== restoreLocalBaseline.value;
      const latestRestoreMarker = readNativeRestoreMarker(
        localStorage.getItem(SETTINGS_NATIVE_RESTORE_PENDING_KEY),
      );
      const localWins = latestRestoreMarker?.localWins ?? [];

      if (validPersistedSettings(native.value) && validPersistedSettings(latestLocal) && localWins.length > 0) {
        local = mergeNativeSettingsWithLocalFields(native.value, latestLocal, localWins);
        localStorage.setItem(SETTINGS_STORAGE_KEY, local);
        await useSettingsStore.persist.rehydrate();
      } else if (localChangedSinceRestoreStarted) {
        local = latestLocal;
        await useSettingsStore.persist.rehydrate();
      } else if (validPersistedSettings(native.value)) {
        localStorage.setItem(SETTINGS_STORAGE_KEY, native.value);
        await useSettingsStore.persist.rehydrate();
        local = native.value;
      } else {
        if (native.value) await SettingsBackup.clear().catch(() => {});
        if (validPersistedSettings(latestLocal)) local = latestLocal;
      }

      const resolvedLocal = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (validPersistedSettings(resolvedLocal)) local = resolvedLocal;
      nativeBackupReadPending = false;
      nativeRestoreLocalBaseline = null;
      localStorage.removeItem(SETTINGS_NATIVE_RESTORE_PENDING_KEY);
    }

    nativeMirrorEnabled = true;
    useSettingsStore.subscribe(() => {
      if (nativeBackupTimer) clearTimeout(nativeBackupTimer);
      nativeBackupTimer = setTimeout(() => {
        nativeBackupTimer = null;
        void mirrorSettingsToNative().catch(() => {});
      }, 250);
    });
    if (local) await enqueueNativeSettingsWrite(local).catch(() => {});

    // A retry can finish while the already-released UI writes a newer local
    // value. Queue it immediately instead of relying only on the 250ms mirror.
    const latestAfterInitialWrite = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (
      validPersistedSettings(latestAfterInitialWrite) &&
      latestAfterInitialWrite !== local
    ) {
      void enqueueNativeSettingsWrite(latestAfterInitialWrite).catch(() => {});
    }

    settingsPersistenceResolvedWithValue = validPersistedSettings(
      localStorage.getItem(SETTINGS_STORAGE_KEY),
    );
  })();
  settingsPersistenceInit = initPromise;
  // Preserve exact-promise single-flight semantics while making a rejected
  // native read retryable on the next call.
  void initPromise.catch(() => {
    if (settingsPersistenceInit === initPromise) {
      settingsPersistenceInit = null;
      nativeMirrorEnabled = false;
    }
  });
  return initPromise;
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
