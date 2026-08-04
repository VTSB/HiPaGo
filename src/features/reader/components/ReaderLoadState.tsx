'use client';

import { useT } from '@/lib/i18n/useT';
import { Spinner } from '@/shared/components/Spinner';

export function ReaderLoadState({
  state,
  onRetry,
  onBack,
  detail,
}: {
  state: 'loading' | 'error' | 'empty';
  onRetry?: () => void;
  onBack?: () => void;
  detail?: string;
}) {
  const t = useT();
  const backButton = onBack ? (
    <button
      type="button"
      onClick={onBack}
      className="fixed left-[calc(1rem+env(safe-area-inset-left))] top-[calc(1rem+env(safe-area-inset-top))] z-50 flex min-h-11 min-w-11 items-center justify-center rounded-full bg-black/75 text-zinc-200 shadow-2xl backdrop-blur-md transition-colors hover:bg-black/90 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      aria-label={t('reader.back')}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="h-5 w-5"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z"
          clipRule="evenodd"
        />
      </svg>
    </button>
  ) : null;

  if (state === 'loading') {
    return (
      <div
        role="status"
        aria-label={t('reader.loading')}
        className="flex min-h-dvh items-center justify-center bg-black"
      >
        {backButton}
        <Spinner size="md" className="border-zinc-600 border-t-white" />
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-black px-6 text-center text-zinc-100"
    >
      {backButton}
      <p className="text-base font-medium">
        {state === 'empty' ? t('reader.empty') : t('reader.loadFailed')}
      </p>
      {detail ? <p className="max-w-xl text-sm text-zinc-400">{detail}</p> : null}
      {state === 'error' && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-11 rounded-full bg-white px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          {t('reader.retry')}
        </button>
      ) : null}
    </div>
  );
}
