import { useCallback } from 'react';
import { useSettingsStore } from '@/lib/store/settings';
import { t, type TranslationKey } from './translations';

export function useT() {
  const locale = useSettingsStore((s) => s.locale);
  return useCallback((key: TranslationKey) => t(key, locale), [locale]);
}
