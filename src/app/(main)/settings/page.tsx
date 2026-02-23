'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useSettingsStore, type Locale } from '@/lib/store/settings';
import { useT } from '@/lib/i18n/useT';
import { searchLocalTags } from '@/lib/db/search-local';
import { getSuggestionsForQuery } from '@/lib/api/search';
import { useDbStatusStore } from '@/lib/store/db-status';
import type { Suggestion } from '@/lib/utils/types';
import { TagChip } from '@/shared/components/TagChip';

function BlurTagInput({ onAdd }: { onAdd: (tag: string) => void }) {
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const dbReady = useDbStatusStore((s) => s.dbReady);
  const locale = useSettingsStore((s) => s.locale);
  const t = useT();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = input.trim();
    if (!trimmed) { setSuggestions([]); return; }
    if (dbReady) {
      searchLocalTags(trimmed).then((r) => { setSuggestions(r); setShowDropdown(r.length > 0); });
    } else if (trimmed.length >= 2) {
      debounceRef.current = setTimeout(async () => {
        try {
          const r = await getSuggestionsForQuery(trimmed);
          setSuggestions(r); setShowDropdown(r.length > 0);
        } catch {}
      }, 300);
    }
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [input, dbReady]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) && !inputRef.current?.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const handleSelect = useCallback((s: Suggestion) => {
    const tag = `${s.tagType}:${s.tag.replace(/ /g, '_')}`;
    onAdd(tag);
    setInput('');
    setSuggestions([]);
    setShowDropdown(false);
  }, [onAdd]);

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onFocus={() => suggestions.length > 0 && setShowDropdown(true)}
        placeholder={t('settings.blurTags.placeholder')}
        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
      />
      {showDropdown && suggestions.length > 0 && (
        <div ref={dropdownRef} className="absolute top-full z-50 mt-1 w-full rounded-lg border border-zinc-300 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800 max-h-60 overflow-y-auto">
          {suggestions.map((s, i) => (
            <button key={`${s.tagType}-${s.tag}-${i}`} type="button" onClick={() => handleSelect(s)}
              className="w-full flex items-center justify-between px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-700">
              <TagChip tag={s.tag} type={s.tagType} displayName={locale === 'ko' && s.localName ? s.localName : undefined} linked={false} size="sm" />
              <span className="text-xs text-zinc-500 ml-auto">{s.amount.toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const locale = useSettingsStore((s) => s.locale);
  const language = useSettingsStore((s) => s.language);
  const theme = useSettingsStore((s) => s.theme);
  const readerMode = useSettingsStore((s) => s.readerMode);
  const imageFormat = useSettingsStore((s) => s.imageFormat);
  const blurTags = useSettingsStore((s) => s.blurTags);
  const setLocale = useSettingsStore((s) => s.setLocale);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setReaderMode = useSettingsStore((s) => s.setReaderMode);
  const setImageFormat = useSettingsStore((s) => s.setImageFormat);
  const addBlurTag = useSettingsStore((s) => s.addBlurTag);
  const removeBlurTag = useSettingsStore((s) => s.removeBlurTag);
  const t = useT();

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else if (theme === 'light') {
      root.classList.remove('dark');
    } else {
      // system theme
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.toggle('dark', prefersDark);
    }
  }, [theme]);

  const btnClass = (active: boolean) =>
    `flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
      active
        ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
        : 'bg-zinc-100 text-zinc-900 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700'
    }`;

  return (
    <>
      <h1 className="mb-6 text-2xl font-bold text-zinc-900 dark:text-zinc-100">{t('settings.title')}</h1>

      <div className="space-y-6">
        {/* System Language */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <label className="mb-2 block text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {t('settings.locale')}
          </label>
          <div className="flex gap-2">
            <button onClick={() => setLocale('en')} className={btnClass(locale === 'en')}>
              {t('settings.locale.en')}
            </button>
            <button onClick={() => setLocale('ko')} className={btnClass(locale === 'ko')}>
              {t('settings.locale.ko')}
            </button>
          </div>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {t('settings.locale.desc')}
          </p>
        </div>

        {/* Language Filter */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <label className="mb-2 block text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {t('settings.langFilter')}
          </label>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          >
            <option value="all">{t('settings.langFilter.all')}</option>
            <option value="japanese">{t('settings.langFilter.japanese')}</option>
            <option value="english">{t('settings.langFilter.english')}</option>
            <option value="chinese">{t('settings.langFilter.chinese')}</option>
            <option value="korean">{t('settings.langFilter.korean')}</option>
          </select>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {t('settings.langFilter.desc')}
          </p>
        </div>

        {/* Theme Toggle */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <label className="mb-2 block text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {t('settings.theme')}
          </label>
          <div className="flex gap-2">
            <button onClick={() => setTheme('light')} className={btnClass(theme === 'light')}>
              {t('settings.theme.light')}
            </button>
            <button onClick={() => setTheme('dark')} className={btnClass(theme === 'dark')}>
              {t('settings.theme.dark')}
            </button>
            <button onClick={() => setTheme('system')} className={btnClass(theme === 'system')}>
              {t('settings.theme.system')}
            </button>
          </div>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {t('settings.theme.desc')}
          </p>
        </div>

        {/* Reader Mode */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <label className="mb-2 block text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {t('settings.reader')}
          </label>
          <div className="flex gap-2">
            <button onClick={() => setReaderMode('page')} className={btnClass(readerMode === 'page')}>
              {t('settings.reader.page')}
            </button>
            <button onClick={() => setReaderMode('scroll')} className={btnClass(readerMode === 'scroll')}>
              {t('settings.reader.scroll')}
            </button>
          </div>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {t('settings.reader.desc')}
          </p>
        </div>

        {/* Image Format */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <label className="mb-2 block text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {t('settings.imageFormat')}
          </label>
          <select
            value={imageFormat}
            onChange={(e) => setImageFormat(e.target.value as 'auto' | 'avif' | 'webp' | 'original')}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          >
            <option value="auto">Auto</option>
            <option value="avif">AVIF</option>
            <option value="webp">WebP</option>
            <option value="original">Original</option>
          </select>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {t('settings.imageFormat.desc')}
          </p>
        </div>

        {/* Blur Tags */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <label className="mb-2 block text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {t('settings.blurTags')}
          </label>
          <BlurTagInput onAdd={addBlurTag} />
          {blurTags.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {blurTags.map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-3 py-1 text-sm text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {tag}
                  <button onClick={() => removeBlurTag(tag)} className="ml-1 text-zinc-400 hover:text-red-500">&times;</button>
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-xs text-zinc-400">{t('settings.blurTags.empty')}</p>
          )}
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {t('settings.blurTags.desc')}
          </p>
        </div>
      </div>
    </>
  );
}
