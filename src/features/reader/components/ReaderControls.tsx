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
  const scrollWidth = useSettingsStore((s) => s.scrollWidth);
  const setScrollWidth = useSettingsStore((s) => s.setScrollWidth);

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

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <div className="flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-2 shadow-2xl backdrop-blur-md">
        <button onClick={onBack} className="rounded-full p-2 text-zinc-400 transition-colors hover:bg-white/10 hover:text-white active:bg-white/10" aria-label={t('reader.back')}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-[22px] w-[22px]"><path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd" /></svg>
        </button>
        <div className="mx-0.5 h-5 w-px bg-zinc-600" />
        <button onClick={onPrevPage} disabled={currentPage <= 0} className="rounded-full p-2 text-zinc-400 transition-colors hover:bg-white/10 hover:text-white active:bg-white/10 disabled:opacity-30" aria-label={t('reader.prev')}>
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
          <button onClick={startEditing} className="min-w-[4.5rem] select-none text-center text-sm tabular-nums text-zinc-300 transition-colors hover:text-white">
            {pageText}
          </button>
        )}
        <button onClick={onNextPage} disabled={currentPage >= totalPages - 1} className="rounded-full p-2 text-zinc-400 transition-colors hover:bg-white/10 hover:text-white active:bg-white/10 disabled:opacity-30" aria-label={t('reader.next')}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-[22px] w-[22px]"><path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" /></svg>
        </button>
        <div className="mx-0.5 h-5 w-px bg-zinc-600" />
        <button onClick={() => onModeChange(mode === 'page' ? 'scroll' : 'page')} className="rounded-full p-2 text-zinc-400 transition-colors hover:bg-white/10 hover:text-white active:bg-white/10" aria-label={mode === 'page' ? t('reader.scroll') : t('reader.page')}>
          {mode === 'page' ? (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-[22px] w-[22px]"><path fillRule="evenodd" d="M2 3.75A.75.75 0 012.75 3h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 3.75zm0 4.167a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75zm0 4.166a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75zm0 4.167a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" clipRule="evenodd" /></svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-[22px] w-[22px]"><path d="M2 4.25A2.25 2.25 0 014.25 2h11.5A2.25 2.25 0 0118 4.25v8.5A2.25 2.25 0 0115.75 15h-11.5A2.25 2.25 0 012 12.75v-8.5zM4.25 3.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h11.5a.75.75 0 00.75-.75v-8.5a.75.75 0 00-.75-.75H4.25z" /><path d="M5 18a1 1 0 011-1h8a1 1 0 110 2H6a1 1 0 01-1-1z" /></svg>
          )}
        </button>
        {mode === 'page' && (
          <button onClick={() => setDualPage(!dualPage)} className={`rounded-full p-2 transition-colors hover:bg-white/10 active:bg-white/10 ${dualPage ? 'text-white' : 'text-zinc-400 hover:text-white'}`} aria-label={dualPage ? '1-page' : '2-page'}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-[22px] w-[22px]">
              {dualPage ? (
                <><rect x="1.5" y="3" width="7.5" height="14" rx="1" /><rect x="11" y="3" width="7.5" height="14" rx="1" /></>
              ) : (
                <rect x="4" y="2" width="12" height="16" rx="1.5" />
              )}
            </svg>
          </button>
        )}
        {mode === 'scroll' && (
          <select
            value={scrollWidth}
            onChange={(e) => setScrollWidth(Number(e.target.value))}
            className="rounded bg-white/10 px-1.5 py-1 text-xs text-zinc-300 outline-none hover:bg-white/20 [&>option]:bg-zinc-900 [&>option]:text-white"
          >
            <option value={10}>10%</option>
            <option value={25}>25%</option>
            <option value={50}>50%</option>
            <option value={75}>75%</option>
            <option value={100}>100%</option>
            <option value={125}>125%</option>
            <option value={150}>150%</option>
            <option value={200}>200%</option>
            <option value={300}>300%</option>
            <option value={500}>500%</option>
            <option value={0}>Full</option>
          </select>
        )}
      </div>
    </div>
  );
}
