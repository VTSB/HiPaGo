'use client';

import { useEffect, useState, useCallback, useRef } from 'react';

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

  // Track scroll position to determine which page the user is viewing
  useEffect(() => {
    if (loadedItems === 0) return;
    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          const scrollTop = window.scrollY;
          const docHeight = document.documentElement.scrollHeight - window.innerHeight;
          if (docHeight <= 0) { setViewingPage(1); ticking = false; return; }
          const ratio = Math.min(scrollTop / docHeight, 1);
          const itemIndex = Math.floor(ratio * (loadedItems - 1));
          const page = Math.floor(itemIndex / pageSize) + 1;
          setViewingPage(page);
          ticking = false;
        });
        ticking = true;
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, [loadedItems, pageSize]);

  const scrollToPage = useCallback((page: number) => {
    const targetIndex = (page - 1) * pageSize;
    const el = document.querySelector(`[data-item-index="${targetIndex}"]`);
    if (el) {
      const headerOffset = 80;
      const top = el.getBoundingClientRect().top + window.scrollY - headerOffset;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  }, [pageSize]);

  const goPrev = useCallback(() => {
    if (viewingPage <= 1) return;
    scrollToPage(viewingPage - 1);
  }, [viewingPage, scrollToPage]);

  const goNext = useCallback(() => {
    const nextPage = viewingPage + 1;
    if (nextPage > loadedPages) {
      if (hasMore && onLoadMore) onLoadMore();
      return;
    }
    scrollToPage(nextPage);
  }, [viewingPage, loadedPages, hasMore, onLoadMore, scrollToPage]);

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

  if (totalPages <= 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 flex items-center gap-1 rounded-full bg-zinc-900/80 px-3 py-2 text-sm text-white shadow-lg backdrop-blur-sm dark:bg-zinc-100/80 dark:text-zinc-900">
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
