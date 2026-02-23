'use client';

import { useSettingsStore } from '@/lib/store/settings';
import { useT } from '@/lib/i18n/useT';

const LANGUAGES = [
  { value: 'all', label: 'all' },
  { value: 'korean', label: '한국어' },
  { value: 'japanese', label: '日本語' },
  { value: 'english', label: 'English' },
  { value: 'chinese', label: '中文' },
];

export function LanguageFilter() {
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const t = useT();

  return (
    <select
      value={language}
      onChange={(e) => setLanguage(e.target.value)}
      aria-label={t('langFilter.label')}
      className="h-9 rounded-md border border-zinc-300 bg-zinc-50 px-2 text-xs font-medium text-zinc-700 outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:focus:border-zinc-500"
    >
      {LANGUAGES.map(({ value, label }) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}
