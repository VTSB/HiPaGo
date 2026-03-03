'use client';

import { useT } from '@/lib/i18n/useT';
import { Select } from '@/shared/components/Select';
import type { SortOrder } from '@/lib/utils/types';
import type { TranslationKey } from '@/lib/i18n/translations';

const SORT_OPTIONS: SortOrder[] = [
  'date_added',
  'popular_year',
  'popular_month',
  'popular_week',
  'popular_day',
];

const SORT_KEYS: Record<SortOrder, TranslationKey> = {
  date_added: 'sort.date_added',
  popular_year: 'sort.popular_year',
  popular_month: 'sort.popular_month',
  popular_week: 'sort.popular_week',
  popular_day: 'sort.popular_day',
};

export function SortSelector({ value, onChange }: { value: SortOrder; onChange: (v: SortOrder) => void }) {
  const t = useT();

  const options = SORT_OPTIONS.map((opt) => ({
    value: opt,
    label: t(SORT_KEYS[opt]),
  }));

  return (
    <Select
      value={value}
      options={options}
      onChange={(v) => { if (SORT_OPTIONS.includes(v as SortOrder)) onChange(v as SortOrder); }}
    />
  );
}
