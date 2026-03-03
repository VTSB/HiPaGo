'use client';

import { useSettingsStore } from '@/lib/store/settings';
import { useT } from '@/lib/i18n/useT';
import { Select } from '@/shared/components/Select';

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
    <Select
      value={language}
      options={LANGUAGES}
      onChange={setLanguage}
      aria-label={t('langFilter.label')}
      className="w-28"
    />
  );
}
