'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useClickOutside } from '@/shared/hooks/useClickOutside';
import { useSettingsStore } from '@/lib/store/settings';
import { useT } from '@/lib/i18n/useT';
import { searchLocalTags } from '@/lib/db/search-local';
import { getSuggestionsForQuery } from '@/lib/api/search';
import { useDbStatusStore } from '@/lib/store/db-status';
import { isHangul } from '@/lib/utils/tag-query';
import type { Suggestion } from '@/lib/utils/types';
import { tagFromSuggestion, toSearchString } from '@/lib/utils/hitomi-tag';
import Link from 'next/link';
import { TagChip } from '@/shared/components/TagChip';
import { Select } from '@/shared/components/Select';
import { UpdateCheckCard } from '@/shared/components/UpdateCheckCard';
import { ImageCacheCard } from '@/shared/components/ImageCacheCard';
import { DownloadLocationCard } from '@/shared/components/DownloadLocationCard';

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
    debounceRef.current = setTimeout(async () => {
      // Empty input — clear. DB not ready + Hangul — the remote tagindex API
      // is English-keyed and would 400, so skip it and clear too. Both run
      // inside the debounced callback rather than the effect body so no
      // setState fires synchronously during the effect.
      if (!trimmed || (!dbReady && isHangul(trimmed))) {
        setSuggestions([]);
        setShowDropdown(false);
        return;
      }
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
    const tag = toSearchString(tagFromSuggestion(s));
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
        className="h-12 w-full rounded-xl border border-zinc-300 bg-white px-4 text-base text-zinc-900 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 sm:h-10 sm:rounded-md sm:px-3 sm:text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
      />
      {showDropdown && suggestions.length > 0 && (
        <div ref={dropdownRef} className="absolute top-full z-50 mt-1 w-full rounded-lg border border-zinc-300 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800 max-h-60 overflow-y-auto">
          {suggestions.map((s, i) => (
            <button key={`${s.tagType}-${s.tag}-${i}`} type="button" onClick={() => handleSelect(s)}
              className="flex min-h-12 w-full items-center justify-between px-4 py-2 text-left text-base active:bg-zinc-100 sm:min-h-0 sm:px-3 sm:text-sm sm:hover:bg-zinc-100 dark:active:bg-zinc-700 sm:dark:hover:bg-zinc-700">
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
    `flex min-h-11 flex-1 items-center justify-center rounded-xl px-4 py-2 text-base font-semibold transition-colors sm:min-h-0 sm:flex-initial sm:rounded-md sm:px-3 sm:py-1.5 sm:text-sm sm:font-medium ${
      active
        ? 'bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900'
        : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'
    }`;

  return (
    <div className="-mx-4 sm:mx-auto sm:max-w-2xl">
      <h1 className="mb-4 px-4 text-2xl font-bold leading-tight text-zinc-900 sm:mb-8 sm:px-0 dark:text-zinc-100">{t('settings.title')}</h1>

      <div className="divide-y divide-zinc-200 border-y border-zinc-200 bg-white sm:rounded-xl sm:border dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
        {/* System Language */}
        <div className="flex flex-col gap-3 px-4 py-5 sm:px-5 sm:py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-base font-semibold text-zinc-900 sm:text-sm sm:font-medium dark:text-zinc-100">{t('settings.locale')}</p>
            <p className="mt-0.5 text-sm leading-snug text-zinc-500 sm:text-xs dark:text-zinc-400">{t('settings.locale.desc')}</p>
          </div>
          <div className="flex w-full gap-1 rounded-2xl bg-zinc-100 p-1 sm:w-auto sm:rounded-lg dark:bg-zinc-800">
            <button onClick={() => setLocale('en')} className={segmentClass(locale === 'en')}>
              {t('settings.locale.en')}
            </button>
            <button onClick={() => setLocale('ko')} className={segmentClass(locale === 'ko')}>
              {t('settings.locale.ko')}
            </button>
          </div>
        </div>

        {/* Language Filter */}
        <div className="flex flex-col gap-3 px-4 py-5 sm:px-5 sm:py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-base font-semibold text-zinc-900 sm:text-sm sm:font-medium dark:text-zinc-100">{t('settings.langFilter')}</p>
            <p className="mt-0.5 text-sm leading-snug text-zinc-500 sm:text-xs dark:text-zinc-400">{t('settings.langFilter.desc')}</p>
          </div>
          <Select
            value={language}
            onChange={setLanguage}
            className="w-full sm:w-36"
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
        <div className="flex flex-col gap-3 px-4 py-5 sm:px-5 sm:py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-base font-semibold text-zinc-900 sm:text-sm sm:font-medium dark:text-zinc-100">{t('settings.reader')}</p>
            <p className="mt-0.5 text-sm leading-snug text-zinc-500 sm:text-xs dark:text-zinc-400">{t('settings.reader.desc')}</p>
          </div>
          <div className="flex w-full gap-1 rounded-2xl bg-zinc-100 p-1 sm:w-auto sm:rounded-lg dark:bg-zinc-800">
            <button onClick={() => setReaderMode('page')} className={segmentClass(readerMode === 'page')}>
              {t('settings.reader.page')}
            </button>
            <button onClick={() => setReaderMode('scroll')} className={segmentClass(readerMode === 'scroll')}>
              {t('settings.reader.scroll')}
            </button>
          </div>
        </div>

        {/* Image Format */}
        <div className="flex flex-col gap-3 px-4 py-5 sm:px-5 sm:py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-base font-semibold text-zinc-900 sm:text-sm sm:font-medium dark:text-zinc-100">{t('settings.imageFormat')}</p>
            <p className="mt-0.5 text-sm leading-snug text-zinc-500 sm:text-xs dark:text-zinc-400">{t('settings.imageFormat.desc')}</p>
          </div>
          <Select
            value={imageFormat}
            onChange={(v) => { const valid = ['auto', 'avif', 'webp', 'original'] as const; if ((valid as readonly string[]).includes(v)) setImageFormat(v as typeof valid[number]); }}
            className="w-full sm:w-32"
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
      <div className="mt-5 border-y border-zinc-200 bg-white sm:mt-6 sm:rounded-xl sm:border dark:border-zinc-800 dark:bg-zinc-900">
        <div className="px-4 py-5 sm:px-5 sm:py-4">
          <p className="text-base font-semibold text-zinc-900 sm:text-sm sm:font-medium dark:text-zinc-100">{t('settings.blurTags')}</p>
          <p className="mb-4 mt-0.5 text-sm leading-snug text-zinc-500 sm:mb-3 sm:text-xs dark:text-zinc-400">{t('settings.blurTags.desc')}</p>
          <BlurTagInput onAdd={addBlurTag} />
          {blurTags.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2 sm:mt-3 sm:gap-1.5">
              {blurTags.map((tag) => (
                <span key={tag} className="inline-flex min-h-9 items-center gap-1 rounded-full bg-zinc-100 px-3 py-1 text-sm text-zinc-600 sm:min-h-0 sm:px-2.5 sm:py-0.5 sm:text-xs dark:bg-zinc-800 dark:text-zinc-400">
                  {tag}
                  <button onClick={() => removeBlurTag(tag)} className="text-zinc-400 hover:text-red-500">&times;</button>
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-zinc-400 sm:mt-3 sm:text-xs">{t('settings.blurTags.empty')}</p>
          )}
        </div>
      </div>

      {/* Image cache */}
      <ImageCacheCard />

      {/* Download location (Android only) */}
      <DownloadLocationCard />

      {/* About / Updates */}
      <UpdateCheckCard />

      {/* Open-source licenses — link to /licenses */}
      <Link
        href="/licenses"
        className="mt-5 flex min-h-20 items-center justify-between border-y border-zinc-200 bg-white px-4 py-5 transition-colors active:bg-zinc-50 sm:mt-6 sm:min-h-0 sm:rounded-xl sm:border sm:px-5 sm:py-4 sm:hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:active:bg-zinc-800/60 sm:dark:hover:bg-zinc-800/60"
      >
        <div>
          <p className="text-base font-semibold text-zinc-900 sm:text-sm sm:font-medium dark:text-zinc-100">{t('licenses.about')}</p>
          <p className="mt-0.5 text-sm leading-snug text-zinc-500 sm:text-xs dark:text-zinc-400">{t('licenses.about.desc')}</p>
        </div>
        <span className="text-zinc-400 dark:text-zinc-500" aria-hidden="true">›</span>
      </Link>
    </div>
  );
}
