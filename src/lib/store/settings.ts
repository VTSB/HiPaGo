import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Locale = 'en' | 'ko';

function detectLocale(): Locale {
  if (typeof navigator !== 'undefined' && navigator.language.startsWith('ko')) {
    return 'ko';
  }
  return 'en';
}

interface SettingsStoreState {
  locale: Locale;
  language: string;
  theme: 'light' | 'dark' | 'system';
  readerMode: 'page' | 'scroll';
  imageFormat: 'auto' | 'avif' | 'webp' | 'original';
  blurTags: string[];
  setLocale: (locale: Locale) => void;
  setLanguage: (language: string) => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setReaderMode: (mode: 'page' | 'scroll') => void;
  setImageFormat: (format: 'auto' | 'avif' | 'webp' | 'original') => void;
  addBlurTag: (tag: string) => void;
  removeBlurTag: (tag: string) => void;
}

export const useSettingsStore = create<SettingsStoreState>()(
  persist(
    (set) => ({
      locale: 'en',
      language: 'all',
      theme: 'system',
      readerMode: 'page',
      imageFormat: 'auto',
      blurTags: ['male:yaoi'],
      setLocale: (locale) => set({ locale }),
      setLanguage: (language) => set({ language }),
      setTheme: (theme) => set({ theme }),
      setReaderMode: (mode) => set({ readerMode: mode }),
      setImageFormat: (format) => set({ imageFormat: format }),
      addBlurTag: (tag) => set((s) => ({ blurTags: s.blurTags.includes(tag) ? s.blurTags : [...s.blurTags, tag] })),
      removeBlurTag: (tag) => set((s) => ({ blurTags: s.blurTags.filter((t) => t !== tag) })),
    }),
    {
      name: 'hipago-settings',
      onRehydrateStorage: () => (state) => {
        // If no persisted locale exists yet, detect from browser
        if (state && !state.locale) {
          state.setLocale(detectLocale());
        }
      },
    },
  ),
);

/** Detect browser locale and apply if this is the first visit (no persisted setting). */
export function initLocaleOnce() {
  const { locale, setLocale } = useSettingsStore.getState();
  // 'en' is the default — if persisted store hasn't overridden it and browser is Korean, apply
  if (locale === 'en' && typeof navigator !== 'undefined' && navigator.language.startsWith('ko')) {
    // Only auto-detect if no value was ever persisted (fresh install)
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('hipago-settings') : null;
    if (!raw) {
      setLocale('ko');
    }
  }
}
