'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useT } from '@/lib/i18n/useT';
import { useHaptic } from '@/shared/hooks/useHaptic';

interface PageJumpModalProps {
  currentPage: number;
  totalPages: number;
  onCommit: (page: number) => void;
  onClose: () => void;
}

export function PageJumpModal({ currentPage, totalPages, onCommit, onClose }: PageJumpModalProps) {
  const t = useT();
  const haptic = useHaptic();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(String(currentPage));

  // Animation state: false = starting (off-screen), true = entered (visible)
  const [entered, setEntered] = useState(false);
  // When closing, we flip entered→false then fire onClose after the transition
  const closingRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Drag state (live drag offset, pixels below rest position)
  const dragStartYRef = useRef<number | null>(null);
  const dragCurrentYRef = useRef<number>(0);
  const [dragOffset, setDragOffset] = useState(0);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Respect prefers-reduced-motion
  const prefersReducedMotion =
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;

  // Slide in on first frame
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Scroll-lock + Esc key
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        requestClose();
      }
    };
    window.addEventListener('keydown', onKey, true);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Animated close — flip state, wait for CSS transition, then notify parent
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setEntered(false);
    const delay = prefersReducedMotion ? 0 : 280;
    closeTimerRef.current = setTimeout(() => {
      onClose();
    }, delay);
  }, [onClose, prefersReducedMotion]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = parseInt(value, 10);
    if (Number.isNaN(n) || n < 1) {
      requestClose();
      return;
    }
    haptic.medium();
    // Commit immediately so scroll begins; sheet unmounts when parent removes it
    onCommit(Math.max(1, Math.min(n, totalPages)));
  };

  // --- Drag-to-dismiss ---

  const onDragStart = useCallback((clientY: number) => {
    dragStartYRef.current = clientY;
    dragCurrentYRef.current = 0;
  }, []);

  const onDragMove = useCallback((clientY: number) => {
    if (dragStartYRef.current === null) return;
    const delta = Math.max(0, clientY - dragStartYRef.current);
    dragCurrentYRef.current = delta;
    setDragOffset(delta);
  }, []);

  const onDragEnd = useCallback(
    (velocity: number) => {
      if (dragStartYRef.current === null) return;
      dragStartYRef.current = null;
      const delta = dragCurrentYRef.current;
      if (delta > 100 || velocity > 0.4) {
        // Dismiss: snap to full-height offset then animate out
        setDragOffset(0);
        requestClose();
      } else {
        // Spring back
        setDragOffset(0);
      }
      dragCurrentYRef.current = 0;
    },
    [requestClose],
  );

  // Pointer events (covers both touch and mouse)
  const pointerStartTimeRef = useRef<number>(0);
  const pointerStartYRef = useRef<number>(0);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only track on the sheet / handle, not inside the form fields
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'BUTTON' ||
        target.closest('form')
      )
        return;
      e.currentTarget.setPointerCapture(e.pointerId);
      pointerStartTimeRef.current = Date.now();
      pointerStartYRef.current = e.clientY;
      onDragStart(e.clientY);
    },
    [onDragStart],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragStartYRef.current === null) return;
      onDragMove(e.clientY);
    },
    [onDragMove],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragStartYRef.current === null) return;
      const elapsed = Date.now() - pointerStartTimeRef.current;
      const distance = e.clientY - pointerStartYRef.current;
      // px/ms downward velocity
      const velocity = elapsed > 0 ? distance / elapsed : 0;
      onDragEnd(velocity);
    },
    [onDragEnd],
  );

  // CSS transition for the sheet panel
  // During live drag we suppress the transition so it tracks the finger directly
  const isDragging = dragOffset > 0;
  const sheetTransitionClass =
    prefersReducedMotion || isDragging
      ? ''
      : 'transition-[transform,opacity] duration-[280ms] ease-out';

  // Translate: compose animation state + live drag offset
  // entered=false → translate full height off bottom; entered=true → translate 0 + drag
  let sheetTranslate: string;
  if (!entered) {
    sheetTranslate = 'translateY(100%)';
  } else if (dragOffset > 0) {
    sheetTranslate = `translateY(${dragOffset}px)`;
  } else {
    sheetTranslate = 'translateY(0)';
  }
  const sheetStyle: React.CSSProperties = prefersReducedMotion
    ? { opacity: entered ? 1 : 0 }
    : { transform: sheetTranslate, opacity: entered ? 1 : 0 };

  const backdropTransitionClass = prefersReducedMotion
    ? ''
    : 'transition-opacity duration-[280ms] ease-out';

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
      aria-labelledby="page-jump-title"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label={t('pageJump.close')}
        onClick={requestClose}
        className={`absolute inset-0 bg-black/40 ${backdropTransitionClass} ${
          entered ? 'opacity-100' : 'opacity-0'
        }`}
        tabIndex={-1}
      />

      {/* Bottom sheet */}
      <div
        ref={sheetRef}
        style={sheetStyle}
        className={`relative z-10 w-full rounded-t-3xl bg-white shadow-2xl dark:bg-zinc-900 ${sheetTransitionClass}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* Constrain content on tablets while keeping the sheet full-width */}
        <div className="mx-auto w-full max-w-md">
          {/* Drag handle */}
          <div className="flex justify-center pb-2 pt-3">
            <div className="h-1.5 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" />
          </div>

          <form
            onSubmit={handleSubmit}
            className="px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]"
          >
            {/* Title */}
            <h2
              id="page-jump-title"
              className="mb-5 text-center text-base font-semibold text-zinc-900 dark:text-zinc-100"
            >
              {t('pageJump.title')}
            </h2>

            {/* Large page number input */}
            <div className="mb-2 flex flex-col items-center gap-1">
              <input
                ref={inputRef}
                type="number"
                inputMode="numeric"
                min={1}
                max={totalPages}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="block w-36 rounded-2xl border-0 bg-zinc-100 px-4 py-3 text-center text-4xl font-bold tabular-nums text-zinc-900 outline-none ring-0 focus:bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-100 dark:focus:bg-zinc-800 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]"
              />
              <p className="text-sm tabular-nums text-zinc-400 dark:text-zinc-500">
                / {totalPages.toLocaleString()}
              </p>
            </div>

            {/* Current page hint */}
            <p className="mb-6 text-center text-xs text-zinc-400 dark:text-zinc-500">
              {t('pageJump.current')}:{' '}
              <span className="font-medium tabular-nums text-zinc-600 dark:text-zinc-400">
                {currentPage}
              </span>
            </p>

            {/* Primary CTA */}
            <button
              type="submit"
              className="mb-3 flex min-h-12 w-full items-center justify-center rounded-full bg-zinc-900 px-6 text-base font-semibold text-white transition active:scale-[0.98] dark:bg-zinc-100 dark:text-zinc-900"
            >
              {t('pageJump.go')}
            </button>

            {/* Secondary: quiet cancel */}
            <button
              type="button"
              onClick={requestClose}
              aria-label={t('pageJump.close')}
              className="flex min-h-10 w-full items-center justify-center rounded-full px-6 text-sm font-medium text-zinc-500 transition hover:text-zinc-700 active:scale-[0.98] dark:text-zinc-400 dark:hover:text-zinc-200"
            >
              {t('pageJump.cancel')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
