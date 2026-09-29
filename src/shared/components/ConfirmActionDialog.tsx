'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@/lib/i18n/useT';
import { lockOverlayScroll, restoreOverlayFocus } from './ActionMenu';

export function ConfirmActionDialog({
  title,
  message,
  onConfirm,
  onCancel,
  busy = false,
  error,
}: {
  title: string;
  message?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const originalFocus = useRef<HTMLElement | null>(null);
  const t = useT();
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!originalFocus.current) originalFocus.current = previousFocus;
    const unlockScroll = lockOverlayScroll();
    (dialog.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? dialog.current)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onCancel();
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        const buttons = Array.from(
          dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
        );
        if (!buttons.length) { dialog.current?.focus(); return; }
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    };
    const onBack = (event: Event) => {
      const overlays = document.querySelectorAll('[data-hipago-overlay]');
      if (overlays[overlays.length - 1] !== dialog.current?.parentElement) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('hipago:overlay-back', onBack);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('hipago:overlay-back', onBack);
      unlockScroll();
      restoreOverlayFocus(originalFocus.current);
    };
  }, [onCancel, busy]);
  return createPortal(
    <div
      data-hipago-overlay="confirmation"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-5"
      onPointerDown={(event) => {
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialog}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="gallery-confirm-title"
        aria-describedby="gallery-confirm-message"
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900"
      >
        <h2 id="gallery-confirm-title" className="font-semibold text-zinc-900 dark:text-zinc-100">
          {title}
        </h2>
        <p
          id="gallery-confirm-message"
          className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300"
        >
          {message ?? title}
        </p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="min-h-11 rounded-lg px-4 text-sm font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {t('actions.cancel')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="min-h-11 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? t('actions.loading') : t('actions.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
