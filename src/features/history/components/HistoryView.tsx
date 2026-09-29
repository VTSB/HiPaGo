'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BackBar } from '@/shared/components/BackBar';
import { ConfirmActionDialog } from '@/shared/components/ConfirmActionDialog';
import { removeHistory, clearHistory } from '@/lib/db/library';
import { getRecentlyViewedWithDates } from '@/lib/db/gallery';
import { filterHistoryByTags } from '@/lib/db/search-local';
import { GalleryCardById } from '@/features/gallery-list/components/GalleryCard';
import { SavedGalleryGrid, type SavedGalleryGridHandle } from '@/features/gallery-list/components/SavedGalleryGrid';
import { Spinner } from '@/shared/components/Spinner';
import { FilterBar } from '@/shared/components/FilterBar';
import { FloatingPageNav } from '@/shared/components/FloatingPageNav';
import { DbErrorBanner } from '@/shared/components/DbErrorBanner';
import { DbStageSpinner } from '@/shared/components/DbStageSpinner';
import { useT } from '@/lib/i18n/useT';
import { useSettingsStore } from '@/lib/store/settings';
import type { TagType } from '@/lib/utils/types';

function toDateKey(viewedAt: string): string {
  const d = new Date(viewedAt);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateLabel(dateKey: string, locale: 'en' | 'ko'): string {
  const now = new Date();
  const todayKey = toDateKey(now.toISOString());

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = toDateKey(yesterday.toISOString());

  if (dateKey === todayKey) return locale === 'ko' ? '오늘' : 'Today';
  if (dateKey === yesterdayKey) return locale === 'ko' ? '어제' : 'Yesterday';

  const [y, m, d] = dateKey.split('-').map(Number);
  if (locale === 'ko') {
    return `${y}년 ${m}월 ${d}일`;
  }
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return `${months[m - 1]} ${d}, ${y}`;
}

function groupByDate(
  entries: Array<{ galleryId: number; viewedAt: string }>,
): Array<{ dateKey: string; ids: number[] }> {
  const map = new Map<string, number[]>();
  const order: string[] = [];
  for (const { galleryId, viewedAt } of entries) {
    const key = toDateKey(viewedAt);
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
      order.push(key);
    }
    list.push(galleryId);
  }
  return order.map((dateKey) => ({ dateKey, ids: map.get(dateKey)! }));
}

const PAGE_SIZE = 25;

export function HistoryView({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [confirm, setConfirm] = useState<'all' | 'selected' | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const deleteRecords = async () => {
    setBusy(true);
    try {
      if (confirm === 'all') await clearHistory();
      else for (const id of selected) await removeHistory(id);
      await Promise.all(['history-grouped','history-filtered','reading-progress','continue-reading'].map(key => queryClient.invalidateQueries({ queryKey: [key] })));
      setSelected([]); setSelecting(false); setConfirm(null);
    } catch { setDeleteError(t('actions.failed')); }
    finally { setBusy(false); }
  };
  const locale = useSettingsStore((s) => s.locale);
  const gridRef = useRef<SavedGalleryGridHandle>(null);

  const [filters, setFilters] = useState<{
    tags: Array<{ type: TagType; name: string }>;
    titleQuery: string;
  }>({ tags: [], titleQuery: '' });
  const hasFilters = filters.tags.length > 0 || filters.titleQuery.length > 0;

  const { data: entries, isLoading } = useQuery({
    queryKey: ['history-grouped'],
    queryFn: () => getRecentlyViewedWithDates(),
    staleTime: 0,
  });

  const { data: filteredIds, isLoading: isFilterLoading } = useQuery({
    queryKey: ['history-filtered', filters],
    queryFn: () => filterHistoryByTags(filters.tags, filters.titleQuery || undefined),
    enabled: hasFilters,
    staleTime: 0,
  });

  const totalCount = entries?.length ?? 0;
  const groups = useMemo(
    () => hasFilters
      ? [{ key: 'filtered', items: filteredIds ?? [] }]
      : groupByDate(entries ?? []).map(({ dateKey, ids }) => ({
          key: dateKey, label: formatDateLabel(dateKey, locale), items: ids,
        })),
    [entries, filteredIds, hasFilters, locale],
  );
  const renderGrid = () => (
    <SavedGalleryGrid ref={gridRef} groups={groups} getItemKey={(id) => id} renderItem={(id) => <GalleryCardById id={id} onBeginSelection={selecting ? undefined : () => { setSelecting(true); setSelected([id]); }} selected={selecting ? selected.includes(id) : undefined} onSelect={selecting ? () => setSelected(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]) : undefined} />} />
  );
  const showFilterBar = !isLoading && (totalCount > 0 || hasFilters);

  return (
    <>
      {!embedded && <BackBar title={t('history.title')} fallbackHref="/more" />}
      {!embedded && (
        <div className="mb-4">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            {t('history.title')}
            {!isLoading && (
              <span className="ml-2 text-lg font-normal text-zinc-500">
                ({totalCount.toLocaleString()})
              </span>
            )}
          </h1>
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        {totalCount > 0 && <><button className="min-h-11 rounded-xl border px-4" onClick={() => { setSelecting(!selecting); setSelected([]); }}>{t(selecting ? 'actions.done' : 'actions.select')}</button>
        <button className="min-h-11 rounded-xl border px-4 text-red-600" onClick={() => { setDeleteError(''); setConfirm('all'); }}>{t('history.clear')}</button></>}
        {selecting && <button disabled={!selected.length} className="min-h-11 rounded-xl border px-4 text-red-600 disabled:opacity-40" onClick={() => { setDeleteError(''); setConfirm('selected'); }}>{t('history.remove')} ({selected.length})</button>}
      </div>
      {confirm && <ConfirmActionDialog title={t('history.confirmDelete')} onCancel={() => setConfirm(null)} onConfirm={deleteRecords} busy={busy} error={deleteError} />}
      <DbErrorBanner />

      {/* Filter bar — hidden when history is empty and no filter active. */}
      {showFilterBar && (
        <div className="mb-4">
          <FilterBar onFilterChange={setFilters} placeholder={t('search.placeholder')} />
        </div>
      )}

      {hasFilters ? (
        isFilterLoading ? (
          <div className="flex justify-center py-12">
            <Spinner size="md" />
          </div>
        ) : filteredIds && filteredIds.length > 0 ? (
          <>
            <p className="mb-3 text-sm text-zinc-500">
              {filteredIds.length.toLocaleString()} {t('search.results')}
            </p>
            {renderGrid()}
            <FloatingPageNav
              totalItems={filteredIds.length}
              loadedItems={filteredIds.length}
              pageSize={PAGE_SIZE}
              onJumpToPage={(page) => gridRef.current?.scrollToItem((page - 1) * PAGE_SIZE)}
            />
          </>
        ) : (
          <p className="text-zinc-500 dark:text-zinc-400">{t('search.noResults')}</p>
        )
      ) : isLoading ? (
        <DbStageSpinner />
      ) : totalCount === 0 ? (
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="h-14 w-14 text-zinc-300 dark:text-zinc-700"
            aria-hidden="true"
          >
            <path
              d="M12 7v5l3 1.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <p className="max-w-xs text-sm text-zinc-500 dark:text-zinc-400">{t('history.empty')}</p>
          <Link
            href="/"
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {t('empty.browseGalleries')}
          </Link>
        </div>
      ) : (
        <>
          {renderGrid()}
          <FloatingPageNav
            totalItems={totalCount}
            loadedItems={totalCount}
            pageSize={PAGE_SIZE}
            onJumpToPage={(page) => gridRef.current?.scrollToItem((page - 1) * PAGE_SIZE)}
          />
        </>
      )}
    </>
  );
}
