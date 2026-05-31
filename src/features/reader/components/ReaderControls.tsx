'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useT } from '@/lib/i18n/useT';
import { useSettingsStore } from '@/lib/store/settings';

export function ReaderControls({ onBack, currentPage, totalPages, mode, onModeChange, onNextPage, onPrevPage, onPageChange }: {
  onBack: () => void; currentPage: number; totalPages: number; mode: 'page' | 'scroll';
  onModeChange: (m: 'page' | 'scroll') => void; onNextPage: () => void; onPrevPage: () => void;
  onPageChange: (page: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();
  const dualPage = useSettingsStore((s) => s.dualPage);
  const setDualPage = useSettingsStore((s) => s.setDualPage);

  const startEditing = useCallback(() => {
    setEditValue(String(currentPage + 1));
    setEditing(true);
  }, [currentPage]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    const num = parseInt(editValue, 10);
    if (isNaN(num) || num < 1) return;
    const target = Math.min(num, totalPages) - 1; // convert to 0-based
    if (target !== currentPage) onPageChange(target);
  }, [editValue, totalPages, currentPage, onPageChange]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const pageText = `${currentPage + 1} / ${totalPages}`;

  // Mobile (<sm):
  //   - Toolbar centered horizontally for thumb-reach.
  //   - 2-page toggle hidden (unreadable side-by-side at 375px).
  // Desktop (≥sm):
  //   - Toolbar pinned bottom-right (original placement; familiar mouse target).
  // Tap targets are ≥44×44 on all viewports — a small win on desktop too,
  // and the original 38px buttons were borderline for any precision-input UX.
  return (
    <div
      className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 will-change-transform sm:left-auto sm:right-4 sm:translate-x-0"
    >
      {/* Reveal is gesture-coupled: `--reader-chrome` (0 shown → 1 hidden) is
          driven imperatively by useScrollReveal so the pill tracks the scroll
          1:1 (no transition = no lag), sliding down off-screen proportionally. */}
      <div
        className="flex items-center gap-0.5 rounded-full bg-black/60 px-2 py-1.5 shadow-2xl backdrop-blur-md will-change-transform sm:gap-1.5 sm:px-3 sm:py-2"
        style={{
          transform: 'translateY(calc(var(--reader-chrome, 0) * 150%))',
          opacity: 'calc(1 - var(--reader-chrome, 0))',
        }}
      >
        <button onClick={onBack} className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-white active:bg-white/10" aria-label={t('reader.back')}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-[22px] w-[22px]"><path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd" /></svg>
        </button>
        <div className="mx-0.5 h-5 w-px bg-zinc-600" />
        <button onClick={onPrevPage} disabled={currentPage <= 0} className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-white active:bg-white/10 disabled:opacity-30" aria-label={t('reader.prev')}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-[22px] w-[22px]"><path fillRule="evenodd" d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z" clipRule="evenodd" /></svg>
        </button>
        {editing ? (
          <form onSubmit={(e) => { e.preventDefault(); commitEdit(); }} className="flex items-center">
            <input
              ref={inputRef}
              type="number"
              min={1}
              max={totalPages}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitEdit}
              className="w-12 rounded bg-white/10 px-1 py-0.5 text-center text-sm tabular-nums text-white outline-none focus:bg-white/20 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <span className="ml-1 text-sm tabular-nums text-zinc-400">/ {totalPages}</span>
          </form>
        ) : (
          <button onClick={startEditing} className="flex min-h-11 min-w-[4.5rem] select-none items-center justify-center text-center text-sm tabular-nums text-zinc-300 transition-colors hover:text-white">
            {pageText}
          </button>
        )}
        <button onClick={onNextPage} disabled={currentPage >= totalPages - 1} className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-white active:bg-white/10 disabled:opacity-30" aria-label={t('reader.next')}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-[22px] w-[22px]"><path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" /></svg>
        </button>
        <div className="mx-0.5 h-5 w-px bg-zinc-600" />
        <button onClick={() => onModeChange(mode === 'page' ? 'scroll' : 'page')} className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-white active:bg-white/10" aria-label={mode === 'page' ? t('reader.scroll') : t('reader.page')}>
          {mode === 'page' ? (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-[22px] w-[22px]"><path fillRule="evenodd" d="M2 3.75A.75.75 0 012.75 3h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 3.75zm0 4.167a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75zm0 4.166a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75zm0 4.167a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" clipRule="evenodd" /></svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-[22px] w-[22px]"><path d="M2 4.25A2.25 2.25 0 014.25 2h11.5A2.25 2.25 0 0118 4.25v8.5A2.25 2.25 0 0115.75 15h-11.5A2.25 2.25 0 012 12.75v-8.5zM4.25 3.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h11.5a.75.75 0 00.75-.75v-8.5a.75.75 0 00-.75-.75H4.25z" /><path d="M5 18a1 1 0 011-1h8a1 1 0 110 2H6a1 1 0 01-1-1z" /></svg>
          )}
        </button>
        {mode === 'page' && (
          // 2-page toggle is hidden on <sm — two pages side-by-side at 375px
          // are unreadable. Users who want it can still use desktop / tablet.
          <button onClick={() => setDualPage(!dualPage)} className={`hidden min-h-11 min-w-11 items-center justify-center rounded-full transition-colors hover:bg-white/10 active:bg-white/10 sm:flex ${dualPage ? 'text-white' : 'text-zinc-400 hover:text-white'}`} aria-label={dualPage ? '1-page' : '2-page'}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-[22px] w-[22px]">
              {dualPage ? (
                <><rect x="1.5" y="3" width="7.5" height="14" rx="1" /><rect x="11" y="3" width="7.5" height="14" rx="1" /></>
              ) : (
                <rect x="4" y="2" width="12" height="16" rx="1.5" />
              )}
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
