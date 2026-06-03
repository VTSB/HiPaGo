'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useT } from '@/lib/i18n/useT';
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

const SHEET_ANIM_MS = 220;

interface SortSheetProps {
  value: SortOrder;
  onChange: (v: SortOrder) => void;
  onClose: () => void;
}

export function SortSheet({ value, onChange, onClose }: SortSheetProps) {
  const t = useT();
  const [entered, setEntered] = useState(false);
  const frameRef = useRef<number>(0);
  const timerRef = useRef<number>(0);

  // Respect prefers-reduced-motion
  const prefersReduced =
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;

  // Mount → enter: always defer setState into a rAF callback so the
  // react-hooks/set-state-in-effect rule is satisfied.
  // Full-motion: rAF #1 mounts, rAF #2 triggers the CSS transition (Header.tsx pattern).
  // Reduced-motion: single rAF — enter immediately without transition delay.
  useEffect(() => {
    if (prefersReduced) {
      frameRef.current = window.requestAnimationFrame(() => setEntered(true));
    } else {
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = window.requestAnimationFrame(() => setEntered(true));
      });
    }
    return () => {
      window.cancelAnimationFrame(frameRef.current);
      window.clearTimeout(timerRef.current);
    };
  }, [prefersReduced]);

  // Animate out, then call onClose
  const dismiss = useCallback(() => {
    if (prefersReduced) {
      onClose();
      return;
    }
    setEntered(false);
    timerRef.current = window.setTimeout(onClose, SHEET_ANIM_MS);
  }, [onClose, prefersReduced]);

  // ESC key dismissal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dismiss]);

  const handleSelect = useCallback(
    (opt: SortOrder) => {
      onChange(opt);
      dismiss();
    },
    [onChange, dismiss],
  );

  return (
    <div className="fixed inset-0 z-[70]" role="presentation">
      {/* Backdrop — fade in/out */}
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity duration-[220ms] ${
          entered ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={dismiss}
        aria-hidden="true"
      />

      {/* Sheet panel — slide up from bottom */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('sort.sheet.title')}
        className={`fixed inset-x-0 bottom-0 rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)] shadow-xl transition-transform duration-[220ms] ease-out dark:bg-zinc-900 ${
          entered ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        {/* Drag handle */}
        <div className="flex justify-center pb-1 pt-3">
          <div className="h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        </div>

        {/* Title row */}
        <div className="px-4 pb-2 pt-1">
          <p className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">
            {t('sort.sheet.title')}
          </p>
        </div>

        {/* Option list */}
        <ul role="listbox" aria-label={t('sort.sheet.title')}>
          {SORT_OPTIONS.map((opt) => {
            const isActive = opt === value;
            return (
              <li key={opt} role="option" aria-selected={isActive}>
                <button
                  type="button"
                  onClick={() => handleSelect(opt)}
                  aria-current={isActive ? 'true' : undefined}
                  className={`flex min-h-12 w-full items-center justify-between px-5 py-3 text-left text-base transition-colors active:bg-zinc-100 dark:active:bg-zinc-800 ${
                    isActive
                      ? 'font-semibold text-zinc-900 dark:text-zinc-50'
                      : 'font-normal text-zinc-700 dark:text-zinc-300'
                  }`}
                >
                  <span>{t(SORT_KEYS[opt])}</span>
                  {isActive && (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className="h-5 w-5 shrink-0 text-zinc-900 dark:text-zinc-50"
                      aria-hidden="true"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
                        clipRule="evenodd"
                      />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        {/* Bottom spacer above safe area */}
        <div className="h-3" />
      </div>
    </div>
  );
}
