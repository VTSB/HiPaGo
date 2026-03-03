'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useClickOutside } from '@/shared/hooks/useClickOutside';
import { useSettingsStore, type Locale } from '@/lib/store/settings';
import { useT } from '@/lib/i18n/useT';
import { searchLocalTags } from '@/lib/db/search-local';
import { getSuggestionsForQuery } from '@/lib/api/search';
import { useDbStatusStore } from '@/lib/store/db-status';
import type { Suggestion } from '@/lib/utils/types';
import { TagChip } from '@/shared/components/TagChip';
import { Select } from '@/shared/components/Select';

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
    debounceRef.current = setTimeout(async () => {
      try {
        if (dbReady) {
          const r = await searchLocalTags(trimmed);
          setSuggestions(r); setShowDropdown(r.length > 0);
        } else if (trimmed.length >= 2) {
          const r = await getSuggestionsForQuery(trimmed);
          setSuggestions(r); setShowDropdown(r.length > 0);
        }
      } catch { /* network/db failure — keep existing suggestions */ }
    }, dbReady ? 120 : 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [input, dbReady]);

  const closeDropdown = useCallback(() => setShowDropdown(false), []);
  useClickOutside([dropdownRef, inputRef], closeDropdown);

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
  const readerMode = useSettingsStore((s) => s.readerMode);
  const imageFormat = useSettingsStore((s) => s.imageFormat);
  const blurTags = useSettingsStore((s) => s.blurTags);
  const setLocale = useSettingsStore((s) => s.setLocale);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const setReaderMode = useSettingsStore((s) => s.setReaderMode);
  const setImageFormat = useSettingsStore((s) => s.setImageFormat);
  const addBlurTag = useSettingsStore((s) => s.addBlurTag);
  const removeBlurTag = useSettingsStore((s) => s.removeBlurTag);
  const t = useT();

  const segmentClass = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? 'bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900'
        : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'
    }`;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-8 text-2xl font-bold text-zinc-900 dark:text-zinc-100">{t('settings.title')}</h1>

      <div className="divide-y divide-zinc-200 rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
        {/* System Language */}
        <div className="flex items-center justify-between px-5 py-4">
          <div>
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t('settings.locale')}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('settings.locale.desc')}</p>
          </div>
          <div className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
            <button onClick={() => setLocale('en')} className={segmentClass(locale === 'en')}>
              {t('settings.locale.en')}
            </button>
            <button onClick={() => setLocale('ko')} className={segmentClass(locale === 'ko')}>
              {t('settings.locale.ko')}
            </button>
          </div>
        </div>

        {/* Language Filter */}
        <div className="flex items-center justify-between px-5 py-4">
          <div>
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t('settings.langFilter')}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('settings.langFilter.desc')}</p>
          </div>
          <Select
            value={language}
            onChange={setLanguage}
            className="w-36"
            options={[
              { value: 'all', label: t('settings.langFilter.all') },
              { value: 'japanese', label: t('settings.langFilter.japanese') },
              { value: 'english', label: t('settings.langFilter.english') },
              { value: 'chinese', label: t('settings.langFilter.chinese') },
              { value: 'korean', label: t('settings.langFilter.korean') },
            ]}
          />
        </div>

        {/* Reader Mode */}
        <div className="flex items-center justify-between px-5 py-4">
          <div>
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t('settings.reader')}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('settings.reader.desc')}</p>
          </div>
          <div className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
            <button onClick={() => setReaderMode('page')} className={segmentClass(readerMode === 'page')}>
              {t('settings.reader.page')}
            </button>
            <button onClick={() => setReaderMode('scroll')} className={segmentClass(readerMode === 'scroll')}>
              {t('settings.reader.scroll')}
            </button>
          </div>
        </div>

        {/* Image Format */}
        <div className="flex items-center justify-between px-5 py-4">
          <div>
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t('settings.imageFormat')}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('settings.imageFormat.desc')}</p>
          </div>
          <Select
            value={imageFormat}
            onChange={(v) => { const valid = ['auto', 'avif', 'webp', 'original'] as const; if ((valid as readonly string[]).includes(v)) setImageFormat(v as typeof valid[number]); }}
            className="w-32"
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'avif', label: 'AVIF' },
              { value: 'webp', label: 'WebP' },
              { value: 'original', label: 'Original' },
            ]}
          />
        </div>

      </div>

      {/* Blur Tags — separate section */}
      <div className="mt-6 rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="px-5 py-4">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t('settings.blurTags')}</p>
          <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">{t('settings.blurTags.desc')}</p>
          <BlurTagInput onAdd={addBlurTag} />
          {blurTags.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {blurTags.map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                  {tag}
                  <button onClick={() => removeBlurTag(tag)} className="text-zinc-400 hover:text-red-500">&times;</button>
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-xs text-zinc-400">{t('settings.blurTags.empty')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
