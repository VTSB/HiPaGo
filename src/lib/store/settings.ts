import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  scrollWidth: number;
  setLocale: (locale: Locale) => void;
  setLanguage: (language: string) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setReaderMode: (mode: 'page' | 'scroll') => void;
  setImageFormat: (format: 'auto' | 'avif' | 'webp' | 'original') => void;
  setDualPage: (dual: boolean) => void;
  setGridColumns: (cols: number) => void;
  setScrollWidth: (w: number) => void;
  addBlurTag: (tag: string) => void;
  removeBlurTag: (tag: string) => void;
}

export const useSettingsStore = create<SettingsStoreState>()(
  persist(
    (set) => ({
      locale: 'en',
      language: 'all',
      theme: 'dark',
      readerMode: 'page',
      imageFormat: 'auto',
      blurTags: ['male:yaoi'],
      dualPage: false,
      gridColumns: 0,
      scrollWidth: 100,
      setLocale: (locale) => set({ locale }),
      setLanguage: (language) => set({ language }),
      setTheme: (theme) => set({ theme }),
      setReaderMode: (mode) => set({ readerMode: mode }),
      setImageFormat: (format) => set({ imageFormat: format }),
      setDualPage: (dual) => set({ dualPage: dual }),
      setGridColumns: (cols) => set({ gridColumns: cols }),
      setScrollWidth: (w) => set({ scrollWidth: w }),
      addBlurTag: (tag) => set((s) => ({ blurTags: s.blurTags.includes(tag) ? s.blurTags : [...s.blurTags, tag] })),
      removeBlurTag: (tag) => set((s) => ({ blurTags: s.blurTags.filter((t) => t !== tag) })),
    }),
    { name: 'hipago-settings' },
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
