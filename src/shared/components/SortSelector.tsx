'use client';

import { useT } from '@/lib/i18n/useT';
import type { SortOrder } from '@/lib/utils/types';

const SORT_OPTIONS: SortOrder[] = [
  'date_added',
  'popular_year',
  'popular_month',
  'popular_week',
  'popular_day',
];

const SORT_KEYS: Record<SortOrder, string> = {
  date_added: 'sort.date_added',
  popular_year: 'sort.popular_year',
  popular_month: 'sort.popular_month',
  popular_week: 'sort.popular_week',
  popular_day: 'sort.popular_day',
};

export function SortSelector({ value, onChange }: { value: SortOrder; onChange: (v: SortOrder) => void }) {
  const t = useT();

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as SortOrder)}
      className="h-9 rounded-md border border-zinc-300 bg-zinc-50 px-2 text-sm text-zinc-700 outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:focus:border-zinc-500"
    >
      {SORT_OPTIONS.map((opt) => (
        <option key={opt} value={opt}>
          {t(SORT_KEYS[opt] as any)}
        </option>
      ))}
    </select>
  );
}
