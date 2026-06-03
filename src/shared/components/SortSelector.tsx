'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n/useT';
import { Select } from '@/shared/components/Select';
import { SortSheet } from '@/shared/components/SortSheet';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
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
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);

  const options = SORT_OPTIONS.map((opt) => ({
    value: opt,
    label: t(SORT_KEYS[opt]),
  }));

  if (!isMobile) {
    // Desktop (≥768px): existing <Select> dropdown, unchanged
    return (
      <Select
        value={value}
        options={options}
        onChange={(v) => { if (SORT_OPTIONS.includes(v as SortOrder)) onChange(v as SortOrder); }}
      />
    );
  }

  // Mobile (<768px): chip button + bottom sheet
  return (
    <>
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        className="flex items-center gap-1.5 rounded-full bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-800 transition-colors active:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:active:bg-zinc-700"
      >
        {/* Up/down arrows glyph (⇅) as inline SVG */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          fill="currentColor"
          className="h-3.5 w-3.5 shrink-0"
          aria-hidden="true"
        >
          <path d="M5 3.5a.5.5 0 0 1 .854-.354l2 2a.5.5 0 0 1-.708.708L6 4.707V12.5a.5.5 0 0 1-1 0V4.707L3.854 5.854a.5.5 0 1 1-.708-.708l2-2ZM11 12.5a.5.5 0 0 1-.854.354l-2-2a.5.5 0 0 1 .708-.708L10 11.293V3.5a.5.5 0 0 1 1 0v7.793l1.146-1.147a.5.5 0 0 1 .708.708l-2 2Z" />
        </svg>
        <span>{t(SORT_KEYS[value])}</span>
      </button>

      {sheetOpen && (
        <SortSheet
          value={value}
          onChange={onChange}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </>
  );
}
