'use client';

import { useEffect, useState, useCallback, useRef, forwardRef, useImperativeHandle } from 'react';
import { useSettingsStore } from '@/lib/store/settings';
import { useT } from '@/lib/i18n/useT';
import { useScrollReveal } from '@/shared/hooks/useScrollReveal';
import { useHaptic } from '@/shared/hooks/useHaptic';
import { PageJumpModal } from '@/shared/components/PageJumpModal';

/** Poll for an element to appear, then call callback. */
export function pollForElement(finder: () => unknown, callback: () => void, maxRetries = 60): void {
  let attempts = 0;
  const check = () => {
    attempts++;
    if (finder()) {
      callback();
    } else if (attempts < maxRetries) {
      setTimeout(check, 50);
    }
  };
  setTimeout(check, 0);
}

/** Pure logic for next-page navigation decision. */
export function getNextPageAction(
  viewingPage: number,
  loadedPages: number,
  totalPages: number,
  hasMore: boolean,
): { action: 'scroll' | 'loadAndScroll' | 'noop'; targetPage: number } {
  if (viewingPage >= totalPages) return { action: 'noop', targetPage: viewingPage };
  const nextPage = viewingPage + 1;
  if (nextPage <= loadedPages) return { action: 'scroll', targetPage: nextPage };
  if (hasMore) return { action: 'loadAndScroll', targetPage: nextPage };
  return { action: 'noop', targetPage: viewingPage };
}

export interface FloatingPageNavHandle {
  /** Suppress scroll-based page tracking for ~400ms (call before programmatic scroll). */
  suppress: () => void;
}

interface FloatingPageNavProps {
  totalItems: number;
  loadedItems: number;
  pageSize: number;
  hasMore?: boolean;
  onLoadMore?: () => void;
  viewingPage?: number;
  onViewingPageChange?: (page: number) => void;
  onJumpToPage?: (page: number) => void;
  isJumping?: boolean;
  firstLoadedPage?: number;
}

const IDLE_FADE_MS = 2000;
const BOUNCE_MS = 240;
const SCROLL_SUPPRESS_MS = 1600;
const SWIPE_MAX_MS = 400;
const SWIPE_MIN_DX = 50;
const SWIPE_MAX_DY = 30;
// Mobile = below the md breakpoint, matching where the BottomNav shows and the
// desktop header nav hides. Keeps the pill from colliding with the bottom tab
// bar in the 640-767 band.
const MOBILE_BREAKPOINT_QUERY = '(max-width: 767px)';

export const FloatingPageNav = forwardRef<FloatingPageNavHandle, FloatingPageNavProps>(
  function FloatingPageNav(
    {
      totalItems,
      loadedItems,
      pageSize,
      hasMore,
      onLoadMore,
      viewingPage: viewingPageProp,
      onViewingPageChange,
      onJumpToPage,
      isJumping,
      firstLoadedPage,
    }: FloatingPageNavProps,
    ref,
  ) {
    const t = useT();
    const haptic = useHaptic();

    const [localViewingPage, setLocalViewingPage] = useState(viewingPageProp ?? 1);
    const viewingPage = viewingPageProp ?? localViewingPage;
    const setViewingPage = useCallback(
      (p: number) => {
        setLocalViewingPage(p);
        onViewingPageChange?.(p);
      },
      [onViewingPageChange],
    );

    const [editing, setEditing] = useState(false);
    const [editValue, setEditValue] = useState('');
    const [showJumpModal, setShowJumpModal] = useState(false);
    const [bouncing, setBouncing] = useState(false);
    const [idle, setIdle] = useState(false);
    const [programmaticScrollVisible, setProgrammaticScrollVisible] = useState(false);

    const inputRef = useRef<HTMLInputElement>(null);
    // Gesture-couple the pill to the window scroll (mobile): scrolling down
    // slides it off the bottom proportionally, scrolling up reveals it by the
    // amount scrolled — native style, not a binary snap. Suppressed during a
    // programmatic page-jump / button scroll and while the jump modal is open.
    // Writes `--list-chrome` on the pill node; the pill's mobile translate-y
    // (below) consumes it. Desktop keeps the pill put via `sm:translate-y-0`.
    const pillRef = useRef<HTMLDivElement>(null);
    useScrollReveal({
      scrollElement: typeof window !== 'undefined' ? window : null,
      targetRef: pillRef,
      disabled: programmaticScrollVisible || showJumpModal,
      varName: '--list-chrome',
    });
    const bounceTimerRef = useRef<number>(0);
    const idleTimerRef = useRef<number>(0);

    const gridColumns = useSettingsStore((s) => s.gridColumns);
    const setGridColumns = useSettingsStore((s) => s.setGridColumns);

    const totalPages = Math.ceil(totalItems / pageSize);
    const loadedPages = Math.ceil(loadedItems / pageSize);

    // Suppress scroll-based page tracking after a button click so the
    // immediate page update isn't overwritten by scroll animation events.
    const suppressScrollRef = useRef(false);
    const suppressTimerRef = useRef(0);
    const suppressScrollTracking = useCallback(() => {
      clearTimeout(suppressTimerRef.current);
      suppressScrollRef.current = true;
      setProgrammaticScrollVisible(true);
      suppressTimerRef.current = window.setTimeout(() => {
        suppressScrollRef.current = false;
        setProgrammaticScrollVisible(false);
      }, SCROLL_SUPPRESS_MS);
    }, []);

    // Suppress scroll tracking when grid columns change to prevent page jumps.
    const prevGridColumnsRef = useRef(gridColumns);
    useEffect(() => {
      if (prevGridColumnsRef.current !== gridColumns) {
        prevGridColumnsRef.current = gridColumns;
        window.setTimeout(suppressScrollTracking, 0);
      }
    }, [gridColumns, suppressScrollTracking]);

    useImperativeHandle(ref, () => ({ suppress: suppressScrollTracking }), [
      suppressScrollTracking,
    ]);

    // Track scroll position by finding the first visible item in the viewport.
    useEffect(() => {
      if (loadedItems === 0) return;
      let ticking = false;
      const headerOffset = 80;
      const onScroll = () => {
        if (!ticking) {
          requestAnimationFrame(() => {
            if (!suppressScrollRef.current) {
              const items = document.querySelectorAll('[data-item-index]');
              let foundPage = 1;
              for (let i = items.length - 1; i >= 0; i--) {
                const rect = items[i].getBoundingClientRect();
                if (rect.top <= headerOffset + 20) {
                  const idx = parseInt((items[i] as HTMLElement).dataset.itemIndex || '0', 10);
                  foundPage = Math.floor(idx / pageSize) + 1;
                  break;
                }
              }
              setViewingPage(foundPage);
            }
            ticking = false;
          });
          ticking = true;
        }
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
      return () => window.removeEventListener('scroll', onScroll);
    }, [loadedItems, pageSize, setViewingPage]);

    // Custom smooth scroll: fast start → decelerate (ease-out).
    const scrollAnimRef = useRef(0);
    const scrollToPage = useCallback(
      (page: number) => {
        suppressScrollTracking();
        const targetIndex = (page - 1) * pageSize;
        const el = document.querySelector(`[data-item-index="${targetIndex}"]`);
        if (!el) return;

        const headerOffset = 80;
        const targetTop = el.getBoundingClientRect().top + window.scrollY - headerOffset;
        const startTop = window.scrollY;
        const distance = targetTop - startTop;
        if (Math.abs(distance) < 1) return;

        const duration = Math.min(300, Math.max(150, Math.abs(distance) * 0.15));
        const startTime = performance.now();

        cancelAnimationFrame(scrollAnimRef.current);
        const animate = (now: number) => {
          const elapsed = now - startTime;
          const tt = Math.min(elapsed / duration, 1);
          const eased = 1 - (1 - tt) ** 3;
          window.scrollTo(0, startTop + distance * eased);
          if (tt < 1) {
            scrollAnimRef.current = requestAnimationFrame(animate);
          }
        };
        scrollAnimRef.current = requestAnimationFrame(animate);
      },
      [pageSize, suppressScrollTracking],
    );

    // Idle-fade timer. Resets on any scroll or pill interaction; sets `idle=true`
    // after IDLE_FADE_MS of silence. Mobile-only via CSS (sm:opacity-100 overrides).
    const resetIdle = useCallback(() => {
      setIdle(false);
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(() => setIdle(true), IDLE_FADE_MS);
    }, []);

    useEffect(() => {
      // Initial idle timer — kick it off without calling resetIdle (which
      // would setIdle(false) synchronously in the effect body and trip
      // react-hooks/set-state-in-effect). Initial state is already false,
      // so we just schedule the first idle flip.
      idleTimerRef.current = window.setTimeout(() => setIdle(true), IDLE_FADE_MS);
      const onScroll = () => resetIdle();
      window.addEventListener('scroll', onScroll, { passive: true });
      return () => {
        window.removeEventListener('scroll', onScroll);
        window.clearTimeout(idleTimerRef.current);
      };
    }, [resetIdle]);

    // Bounce + haptic when user taps past a boundary.
    const triggerBounce = useCallback(() => {
      setBouncing(true);
      window.clearTimeout(bounceTimerRef.current);
      bounceTimerRef.current = window.setTimeout(() => setBouncing(false), BOUNCE_MS);
      haptic.light();
    }, [haptic]);

    useEffect(() => () => window.clearTimeout(bounceTimerRef.current), []);

    // Core nav primitives — these don't fire bounce themselves; the wrapper does.
    const goPrev = useCallback(() => {
      const firstPage = firstLoadedPage ?? 1;
      if (viewingPage <= firstPage) return false;
      const target = viewingPage - 1;
      setViewingPage(target);
      suppressScrollTracking();
      const el = document.querySelector(`[data-item-index="${(target - 1) * pageSize}"]`);
      if (el) scrollToPage(target);
      else onJumpToPage?.(target);
      return true;
    }, [
      viewingPage,
      firstLoadedPage,
      pageSize,
      scrollToPage,
      onJumpToPage,
      setViewingPage,
      suppressScrollTracking,
    ]);

    const goNext = useCallback(() => {
      const result = getNextPageAction(viewingPage, loadedPages, totalPages, !!hasMore);
      switch (result.action) {
        case 'scroll': {
          setViewingPage(result.targetPage);
          suppressScrollTracking();
          const el = document.querySelector(
            `[data-item-index="${(result.targetPage - 1) * pageSize}"]`,
          );
          if (el) scrollToPage(result.targetPage);
          else onJumpToPage?.(result.targetPage);
          return true;
        }
        case 'loadAndScroll': {
          setViewingPage(result.targetPage);
          suppressScrollTracking();
          onLoadMore?.();
          const targetIndex = (result.targetPage - 1) * pageSize;
          pollForElement(
            () => document.querySelector(`[data-item-index="${targetIndex}"]`),
            () => scrollToPage(result.targetPage),
          );
          return true;
        }
        case 'noop':
          return false;
      }
    }, [
      viewingPage,
      loadedPages,
      totalPages,
      hasMore,
      onLoadMore,
      scrollToPage,
      pageSize,
      onJumpToPage,
      setViewingPage,
      suppressScrollTracking,
    ]);

    // Bounce-on-boundary wrappers — fire haptic + scale pulse if at limit, else delegate.
    const goPrevWithBounce = useCallback(() => {
      resetIdle();
      const moved = goPrev();
      if (!moved) triggerBounce();
    }, [goPrev, resetIdle, triggerBounce]);

    const goNextWithBounce = useCallback(() => {
      resetIdle();
      const moved = goNext();
      if (!moved) triggerBounce();
    }, [goNext, resetIdle, triggerBounce]);

    const startEditing = useCallback(() => {
      setEditValue(String(viewingPage));
      setEditing(true);
      resetIdle();
    }, [viewingPage, resetIdle]);

    const commitEdit = useCallback(() => {
      setEditing(false);
      const num = parseInt(editValue, 10);
      if (isNaN(num) || num < 1) return;
      const target = Math.max(1, Math.min(num, totalPages));
      if (target === viewingPage) return;
      setViewingPage(target);
      suppressScrollTracking();
      const targetIndex = (target - 1) * pageSize;
      const el = document.querySelector(`[data-item-index="${targetIndex}"]`);
      if (el) {
        scrollToPage(target);
      } else if (target === viewingPage + 1) {
        goNext();
      } else {
        onJumpToPage?.(target);
      }
    }, [
      editValue,
      totalPages,
      viewingPage,
      pageSize,
      scrollToPage,
      goNext,
      onJumpToPage,
      setViewingPage,
      suppressScrollTracking,
    ]);

    // Focus the inline desktop input when entering edit mode.
    useEffect(() => {
      if (editing) inputRef.current?.select();
    }, [editing]);

    // Arrow key navigation (window-level). Skips when typing in an editable element.
    useEffect(() => {
      function handleKeyDown(e: KeyboardEvent) {
        const el = e.target as HTMLElement;
        const tag = el?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (el?.isContentEditable) return;
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          goPrevWithBounce();
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          goNextWithBounce();
        }
      }
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, [goPrevWithBounce, goNextWithBounce]);

    const shrinkGrid = useCallback(() => {
      const current = gridColumns || 5;
      if (current > 2) setGridColumns(current - 1);
    }, [gridColumns, setGridColumns]);

    const growGrid = useCallback(() => {
      const current = gridColumns || 5;
      if (current < 7) setGridColumns(current + 1);
    }, [gridColumns, setGridColumns]);

    // Swipe gesture handler — mobile only. Vertical scroll always wins via |dy|<30 guard.
    const touchStartRef = useRef<{
      x: number;
      y: number;
      t: number;
      target: EventTarget | null;
    } | null>(null);
    const onTouchStart = useCallback(
      (e: React.TouchEvent) => {
        const tt = e.touches[0];
        touchStartRef.current = {
          x: tt.clientX,
          y: tt.clientY,
          t: Date.now(),
          target: e.currentTarget,
        };
        resetIdle();
      },
      [resetIdle],
    );
    const onTouchEnd = useCallback(
      (e: React.TouchEvent) => {
        const start = touchStartRef.current;
        touchStartRef.current = null;
        if (!start) return;
        if (start.target !== e.currentTarget) return;
        const end = e.changedTouches[0];
        const dx = end.clientX - start.x;
        const dy = end.clientY - start.y;
        const dt = Date.now() - start.t;
        if (dt > SWIPE_MAX_MS) return;
        if (Math.abs(dy) > SWIPE_MAX_DY) return;
        if (Math.abs(dx) < SWIPE_MIN_DX) return;
        if (dx < 0) goNextWithBounce();
        else goPrevWithBounce();
      },
      [goPrevWithBounce, goNextWithBounce],
    );

    if (totalPages <= 0) return null;

    const effectiveCols = gridColumns || 5;
    const atFirst = viewingPage <= (firstLoadedPage ?? 1) || !!isJumping;
    const atLast = viewingPage >= totalPages || !!isJumping;

    return (
      <>
        <div
          ref={pillRef}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          onPointerDown={resetIdle}
          className={[
            // Mobile: small chip floating just ABOVE the bottom nav so it stays
            // visible/tappable; on scroll-down it slides down behind the nav
            // (z-30 < nav z-40). Desktop (>=md): unchanged bottom-right pill.
            'fixed bottom-[calc(var(--bottom-nav-h)+0.5rem)] z-30 flex items-center gap-0.5 rounded-full bg-zinc-900/90 px-2 py-1 text-sm text-white shadow-lg backdrop-blur-sm md:bottom-4 md:z-40 md:gap-1 md:px-2 md:py-1 md:text-sm dark:bg-zinc-100/90 dark:text-zinc-900',
            // D1: mobile center, desktop bottom-right.
            'left-1/2 -translate-x-1/2 md:left-auto md:right-4 md:translate-x-0',
            // Tailwind v4 writes `translate-*` to the standalone `translate:` CSS
            // property and `scale-*` to `scale:`, NOT to legacy `transform: translate(...)`.
            // The transition list names them directly. `translate` is intentionally
            // OMITTED so the gesture-coupled vertical slide (below) tracks the scroll
            // 1:1 with no lag; `scale` (D6 bounce) + `opacity` (D8 idle) stay animated.
            'transition-[scale,opacity] duration-300 ease-out',
            // D5: gesture-coupled slide hide on scroll-down (mobile). The
            // `--list-chrome` var (0 shown → 1 hidden) is driven by useScrollReveal;
            // the slide clears BOTH the pill height AND the `bottom-4` (1rem) anchor
            // via `calc(100% + 1rem + safe-area)`, scaled by the var so it follows the
            // scroll proportionally (no binary snap, no opacity-0 fighting the var —
            // at var=1 the pill is fully off-screen). `-translate-x-1/2` (D1) composes
            // through Tailwind v4's single `translate:` property. `sm:translate-y-0`
            // keeps desktop put — byte-identical to before on ≥sm.
            'translate-y-[calc(var(--list-chrome,0)*(100%_+_var(--bottom-nav-h)_+_0.5rem))] md:translate-y-0',
            // D8: idle fade (mobile only). When the pill is hidden it is off-screen,
            // so the fade only reads while it is (partially) shown.
            idle ? 'opacity-40 md:opacity-100' : '',
            // D6: bounce pulse at boundaries.
            bouncing ? 'scale-105' : 'scale-100',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {/* D3: Grid column controls — desktop only. */}
          <button
            onClick={() => {
              shrinkGrid();
              resetIdle();
            }}
            disabled={effectiveCols <= 2}
            className="hidden md:inline-flex min-h-11 min-w-11 items-center justify-center rounded-full hover:bg-white/20 disabled:opacity-30 dark:hover:bg-black/20"
            aria-label={t('pageNav.shrinkGrid')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="h-4 w-4"
            >
              <path d="M3.75 7.25a.75.75 0 000 1.5h8.5a.75.75 0 000-1.5h-8.5z" />
            </svg>
          </button>
          <button
            onClick={() => {
              growGrid();
              resetIdle();
            }}
            disabled={effectiveCols >= 7}
            className="hidden md:inline-flex min-h-11 min-w-11 items-center justify-center rounded-full hover:bg-white/20 disabled:opacity-30 dark:hover:bg-black/20"
            aria-label={t('pageNav.growGrid')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="h-4 w-4"
            >
              <path d="M8.75 3.75a.75.75 0 00-1.5 0v3.5h-3.5a.75.75 0 000 1.5h3.5v3.5a.75.75 0 001.5 0v-3.5h3.5a.75.75 0 000-1.5h-3.5v-3.5z" />
            </svg>
          </button>
          <div className="hidden md:block mx-0.5 h-4 w-px bg-white/20 dark:bg-black/20" />

          {/* D2: prev chevron — SVG, 44×44. */}
          <button
            onClick={goPrevWithBounce}
            disabled={atFirst}
            className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-full active:bg-white/20 disabled:opacity-30 md:min-h-11 md:min-w-11 md:hover:bg-white/20 dark:active:bg-black/20 md:dark:hover:bg-black/20"
            aria-label={t('pageNav.prev')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <path d="M10 4l-4 4 4 4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {/* D4: page-jump label/input. Desktop = inline number input (existing).
            Mobile = button that opens PageJumpModal. */}
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                commitEdit();
              }}
              className="flex items-center gap-1 px-1"
            >
              <input
                ref={inputRef}
                type="number"
                inputMode="numeric"
                min={1}
                max={totalPages}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitEdit}
                className="w-14 rounded bg-white/20 px-1 py-0.5 text-center tabular-nums text-white outline-none dark:bg-black/20 dark:text-zinc-900 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]"
              />
              <span className="tabular-nums">/ {totalPages.toLocaleString()}</span>
            </form>
          ) : (
            <button
              onClick={() => {
                resetIdle();
                if (
                  typeof window !== 'undefined' &&
                  window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches
                ) {
                  setShowJumpModal(true);
                } else {
                  startEditing();
                }
              }}
              className="inline-flex min-h-8 min-w-[4.5rem] cursor-text items-center justify-center rounded-full px-2 text-center leading-none tabular-nums whitespace-nowrap active:bg-white/10 md:min-h-11 md:min-w-[5rem] md:hover:bg-white/10 dark:active:bg-black/10 md:dark:hover:bg-black/10"
              aria-label={t('pageNav.jumpToPage')}
            >
              {viewingPage}&nbsp;/&nbsp;{totalPages.toLocaleString()}
            </button>
          )}

          {/* D2: next chevron — SVG, 44×44. */}
          <button
            onClick={goNextWithBounce}
            disabled={atLast}
            className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-full active:bg-white/20 disabled:opacity-30 md:min-h-11 md:min-w-11 md:hover:bg-white/20 dark:active:bg-black/20 md:dark:hover:bg-black/20"
            aria-label={t('pageNav.next')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {showJumpModal && (
          <PageJumpModal
            currentPage={viewingPage}
            totalPages={totalPages}
            onCommit={(target) => {
              setShowJumpModal(false);
              resetIdle();
              const clamped = Math.max(1, Math.min(target, totalPages));
              if (clamped === viewingPage) return;
              setViewingPage(clamped);
              suppressScrollTracking();
              const targetIndex = (clamped - 1) * pageSize;
              const el = document.querySelector(`[data-item-index="${targetIndex}"]`);
              if (el) {
                scrollToPage(clamped);
              } else if (clamped === viewingPage + 1) {
                goNext();
              } else {
                onJumpToPage?.(clamped);
              }
            }}
            onClose={() => {
              setShowJumpModal(false);
              resetIdle();
            }}
          />
        )}
      </>
    );
  },
);
