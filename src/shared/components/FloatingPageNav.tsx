'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useSettingsStore } from '@/lib/store/settings';

/** Poll for an element to appear, then call callback. */
export function pollForElement(
  finder: () => unknown,
  callback: () => void,
  maxRetries = 60,
): void {
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

interface FloatingPageNavProps {
  /** Total number of items across all pages */
  totalItems: number;
  /** Number of items currently rendered */
  loadedItems: number;
  /** Items per page */
  pageSize: number;
  /** Whether more pages can be loaded */
  hasMore?: boolean;
  /** Called when user navigates past loaded content */
  onLoadMore?: () => void;
}

export function FloatingPageNav({
  totalItems,
  loadedItems,
  pageSize,
  hasMore,
  onLoadMore,
}: FloatingPageNavProps) {
  const [viewingPage, setViewingPage] = useState(1);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const totalPages = Math.ceil(totalItems / pageSize);
  const loadedPages = Math.ceil(loadedItems / pageSize);

  // Track scroll position by finding the first visible item in the viewport
  useEffect(() => {
    if (loadedItems === 0) return;
    let ticking = false;
    const headerOffset = 80;
    const onScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          // Find the first item whose top is at or below the header offset
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
          ticking = false;
        });
        ticking = true;
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, [loadedItems, pageSize]);

  // Custom smooth scroll: fast start → decelerate (ease-out)
  const scrollAnimRef = useRef(0);
  const scrollToPage = useCallback((page: number) => {
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
      const t = Math.min(elapsed / duration, 1);
      // ease-out cubic: fast start, smooth deceleration
      const eased = 1 - (1 - t) ** 3;
      window.scrollTo(0, startTop + distance * eased);
      if (t < 1) {
        scrollAnimRef.current = requestAnimationFrame(animate);
      }
    };
    scrollAnimRef.current = requestAnimationFrame(animate);
  }, [pageSize]);

  const goPrev = useCallback(() => {
    if (viewingPage <= 1) return;
    scrollToPage(viewingPage - 1);
  }, [viewingPage, scrollToPage]);

  const goNext = useCallback(() => {
    const result = getNextPageAction(viewingPage, loadedPages, totalPages, !!hasMore);
    switch (result.action) {
      case 'scroll':
        scrollToPage(result.targetPage);
        break;
      case 'loadAndScroll': {
        onLoadMore?.();
        // Poll for the target element to appear after data loads, then scroll
        const targetIndex = (result.targetPage - 1) * pageSize;
        pollForElement(
          () => document.querySelector(`[data-item-index="${targetIndex}"]`),
          () => scrollToPage(result.targetPage),
        );
        break;
      }
      case 'noop':
        break;
    }
  }, [viewingPage, loadedPages, totalPages, hasMore, onLoadMore, scrollToPage, pageSize]);

  const startEditing = useCallback(() => {
    setEditValue(String(viewingPage));
    setEditing(true);
  }, [viewingPage]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    const num = parseInt(editValue, 10);
    if (isNaN(num) || num < 1) return;
    const target = Math.min(num, loadedPages);
    if (target !== viewingPage) {
      scrollToPage(target);
    }
  }, [editValue, loadedPages, viewingPage, scrollToPage]);

  // Focus input when editing starts
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // Arrow key navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Skip if user is typing in an input/textarea/select/contentEditable
      const el = e.target as HTMLElement;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (el?.isContentEditable) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goPrev, goNext]);

  const gridColumns = useSettingsStore((s) => s.gridColumns);
  const setGridColumns = useSettingsStore((s) => s.setGridColumns);

  const shrinkGrid = useCallback(() => {
    const current = gridColumns || 5;
    if (current > 2) setGridColumns(current - 1);
  }, [gridColumns, setGridColumns]);

  const growGrid = useCallback(() => {
    const current = gridColumns || 5;
    if (current < 7) setGridColumns(current + 1);
  }, [gridColumns, setGridColumns]);

  if (totalPages <= 0) return null;

  const effectiveCols = gridColumns || 5;

  return (
    <div className="fixed bottom-4 right-4 z-40 flex items-center gap-1 rounded-full bg-zinc-900/80 px-3 py-2 text-sm text-white shadow-lg backdrop-blur-sm dark:bg-zinc-100/80 dark:text-zinc-900">
      <button
        onClick={shrinkGrid}
        disabled={effectiveCols <= 2}
        className="rounded-full px-1.5 py-0.5 hover:bg-white/20 disabled:opacity-30 dark:hover:bg-black/20"
        aria-label="Larger cards"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5"><path d="M3.75 7.25a.75.75 0 000 1.5h8.5a.75.75 0 000-1.5h-8.5z" /></svg>
      </button>
      <button
        onClick={growGrid}
        disabled={effectiveCols >= 7}
        className="rounded-full px-1.5 py-0.5 hover:bg-white/20 disabled:opacity-30 dark:hover:bg-black/20"
        aria-label="Smaller cards"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5"><path d="M8.75 3.75a.75.75 0 00-1.5 0v3.5h-3.5a.75.75 0 000 1.5h3.5v3.5a.75.75 0 001.5 0v-3.5h3.5a.75.75 0 000-1.5h-3.5v-3.5z" /></svg>
      </button>
      <div className="mx-0.5 h-4 w-px bg-white/20 dark:bg-black/20" />
      <button
        onClick={goPrev}
        disabled={viewingPage <= 1}
        className="rounded-full px-2 py-0.5 hover:bg-white/20 disabled:opacity-30 dark:hover:bg-black/20"
        aria-label="Previous page"
      >
        &lsaquo;
      </button>
      {editing ? (
        <form
          onSubmit={(e) => { e.preventDefault(); commitEdit(); }}
          className="flex items-center gap-1"
        >
          <input
            ref={inputRef}
            type="number"
            min={1}
            max={totalPages}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitEdit}
            className="w-12 rounded bg-white/20 px-1 py-0.5 text-center tabular-nums text-white outline-none dark:bg-black/20 dark:text-zinc-900 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]"
          />
          <span>/ {totalPages.toLocaleString()}</span>
        </form>
      ) : (
        <button
          onClick={startEditing}
          className="min-w-[4rem] cursor-text rounded px-1 py-0.5 text-center tabular-nums hover:bg-white/10 dark:hover:bg-black/10"
        >
          {viewingPage} / {totalPages.toLocaleString()}
        </button>
      )}
      <button
        onClick={goNext}
        disabled={viewingPage >= totalPages}
        className="rounded-full px-2 py-0.5 hover:bg-white/20 disabled:opacity-30 dark:hover:bg-black/20"
        aria-label="Next page"
      >
        &rsaquo;
      </button>
    </div>
  );
}
