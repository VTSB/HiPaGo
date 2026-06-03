'use client';

import { useRouter } from 'next/navigation';
import { useT } from '@/lib/i18n/useT';

interface BackBarProps {
  /** Contextual title shown next to the back chevron. */
  title?: string;
  /** Custom back handler. Defaults to router.back() with a history fallback. */
  onBack?: () => void;
  /** Where to go when there is no in-app history (deep link / cold open). */
  fallbackHref?: string;
}

/**
 * Mobile-only (md:hidden) top back bar for STACKED routes (gallery detail,
 * licenses, …). The desktop equivalent is the sticky header. Sticky, safe-area
 * aware. ← pops one history level (router.back); on a cold open with no
 * in-app history it falls back to `fallbackHref` so the button is never a
 * dead end. Search results render their own ←-next-to-the-search-box variant.
 */
export function BackBar({ title, onBack, fallbackHref = '/' }: BackBarProps) {
  const router = useRouter();
  const t = useT();

  const handleBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
      return;
    }
    router.replace(fallbackHref);
  };

  return (
    <div className="sticky top-0 z-30 -mx-4 mb-2 flex items-center gap-1 bg-zinc-50/85 px-2 pt-[env(safe-area-inset-top)] backdrop-blur-sm md:hidden dark:bg-zinc-950/85">
      <button
        type="button"
        onClick={handleBack}
        aria-label={t('detail.back')}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-700 transition-colors active:bg-zinc-200/60 dark:text-zinc-200 dark:active:bg-zinc-800/60"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          aria-hidden="true"
          className="h-6 w-6"
        >
          <path d="m15 5-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {title && (
        <h2 className="min-w-0 flex-1 truncate py-2 pr-2 text-base font-semibold text-zinc-900 dark:text-zinc-100">
          {title}
        </h2>
      )}
    </div>
  );
}
