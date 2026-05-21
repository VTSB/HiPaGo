'use client';

import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n/useT';

interface PageJumpModalProps {
  currentPage: number;
  totalPages: number;
  onCommit: (page: number) => void;
  onClose: () => void;
}

export function PageJumpModal({ currentPage, totalPages, onCommit, onClose }: PageJumpModalProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(String(currentPage));

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = parseInt(value, 10);
    if (Number.isNaN(n) || n < 1) {
      onClose();
      return;
    }
    onCommit(Math.max(1, Math.min(n, totalPages)));
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="page-jump-title"
    >
      <button
        type="button"
        aria-label={t('pageJump.close')}
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
      />
      <form
        onSubmit={handleSubmit}
        className="relative z-10 m-4 w-full max-w-xs rounded-2xl bg-white p-6 shadow-2xl dark:bg-zinc-900"
      >
        <h2
          id="page-jump-title"
          className="mb-1 text-base font-semibold text-zinc-900 dark:text-zinc-100"
        >
          {t('pageJump.title')}
        </h2>
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          {t('pageJump.current')}:{' '}
          <span className="font-medium tabular-nums text-zinc-700 dark:text-zinc-300">
            {currentPage}
          </span>{' '}
          / {totalPages.toLocaleString()}
        </p>
        <input
          ref={inputRef}
          type="number"
          inputMode="numeric"
          min={1}
          max={totalPages}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mb-5 block w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 text-center text-2xl tabular-nums text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 min-h-11 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {t('pageJump.cancel')}
          </button>
          <button
            type="submit"
            className="flex-1 min-h-11 rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {t('pageJump.go')}
          </button>
        </div>
      </form>
    </div>
  );
}
