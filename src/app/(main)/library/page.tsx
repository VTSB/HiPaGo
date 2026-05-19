'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Spinner } from '@/shared/components/Spinner';
import { useT } from '@/lib/i18n/useT';
import { listDownloads, searchDownloads, deleteDownload } from '@/lib/db/download';
import { createDownloadStore } from '@/lib/storage/download-store';
import type { DBDownload } from '@/lib/db/schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: DBDownload['status'] }) {
  const t = useT();
  const labelKey =
    status === 'complete'
      ? 'library.status.complete'
      : status === 'downloading'
        ? 'library.status.downloading'
        : 'library.status.failed';

  const colorClass =
    status === 'complete'
      ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
      : status === 'downloading'
        ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
        : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colorClass}`}>
      {t(labelKey)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Per-item gallery card for the library list
// ---------------------------------------------------------------------------

interface LibraryCardProps {
  item: DBDownload;
  onDelete: (galleryId: number) => void;
  onExport: (galleryId: number, title: string) => void;
}

function LibraryCard({ item, onDelete, onExport }: LibraryCardProps) {
  const t = useT();

  return (
    <div className="flex gap-4 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      {/* Thumbnail */}
      <div className="h-24 w-16 shrink-0 overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-800">
        {item.thumbnail ? (
          // Plain <img>: thumbnails are remote hitomi URLs served through a
          // custom proxy, not next/image-optimizable.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.thumbnail}
            alt={item.title}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-zinc-400">?</div>
        )}
      </div>

      {/* Info */}
      <div className="flex min-w-0 flex-1 flex-col justify-between gap-1">
        <div>
          <h3 className="line-clamp-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {item.title || `#${item.galleryId}`}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span>{item.pageCount} {t('library.pages')}</span>
            <span>{formatBytes(item.totalBytes)}</span>
            <span>{formatDate(item.downloadedAt)}</span>
            <StatusBadge status={item.status} />
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/gallery/${item.galleryId}`}
            className="inline-flex items-center rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {t('library.open')}
          </Link>
          <button
            type="button"
            onClick={() => onExport(item.galleryId, item.title)}
            className="inline-flex items-center rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {t('library.exportZip')}
          </button>
          <button
            type="button"
            onClick={() => onDelete(item.galleryId)}
            className="inline-flex items-center rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
          >
            {t('library.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Debounced search input (plain text, no tag autocomplete needed here)
// ---------------------------------------------------------------------------

interface SearchInputSimpleProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

function SearchInputSimple({ value, onChange, placeholder }: SearchInputSimpleProps) {
  return (
    <div className="relative flex items-center w-full">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-10 px-3 pr-8 rounded-lg border border-zinc-700 bg-zinc-900
          text-white text-sm outline-none focus:border-zinc-500 transition-colors
          placeholder:text-zinc-500"
        placeholder={placeholder}
      />
      {value && (
        <button
          onMouseDown={(e) => { e.preventDefault(); onChange(''); }}
          className="absolute right-2 text-zinc-500 hover:text-zinc-300 text-lg"
          aria-label="Clear"
        >
          ×
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Storage indicator
// ---------------------------------------------------------------------------

function StorageIndicator() {
  const t = useT();
  const [usageBytes, setUsageBytes] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    createDownloadStore()
      .then((store) => store.usage())
      .then((bytes) => { if (!cancelled) setUsageBytes(bytes); })
      .catch(() => { /* storage unavailable */ });
    return () => { cancelled = true; };
  }, []);

  if (usageBytes === null) return null;

  return (
    <p className="text-sm text-zinc-500 dark:text-zinc-400">
      {t('library.storageUsed')}: <span className="font-medium text-zinc-700 dark:text-zinc-300">{formatBytes(usageBytes)}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 250;

export default function LibraryPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [rawQuery, setRawQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleQueryChange = useCallback((v: string) => {
    setRawQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(v), DEBOUNCE_MS);
  }, []);

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const hasQuery = debouncedQuery.trim().length > 0;

  const { data: allItems, isLoading } = useQuery({
    queryKey: ['library-list'],
    queryFn: () => listDownloads(),
    staleTime: 0,
  });

  const { data: filteredItems, isLoading: isFilterLoading } = useQuery({
    queryKey: ['library-search', debouncedQuery],
    queryFn: () => searchDownloads({ query: debouncedQuery }),
    enabled: hasQuery,
    staleTime: 0,
  });

  const activeItems = hasQuery ? filteredItems : allItems;
  const activeLoading = hasQuery ? isFilterLoading : isLoading;

  const totalCount = activeItems?.length ?? 0;

  // Delete handler: remove DB row + DownloadStore files, then invalidate queries
  const handleDelete = useCallback(async (galleryId: number) => {
    if (!window.confirm(t('library.confirmDelete'))) return;
    try {
      await deleteDownload(galleryId);
      try {
        const store = await createDownloadStore();
        await store.deleteGallery(galleryId);
      } catch {
        // Storage adapter may not be present or files already gone — DB row is still removed
      }
    } catch {
      // DB delete failed — nothing to do
    }
    queryClient.invalidateQueries({ queryKey: ['library-list'] });
    queryClient.invalidateQueries({ queryKey: ['library-search'] });
  }, [t, queryClient]);

  // Export a downloaded gallery's stored images back out as a ZIP.
  const handleExport = useCallback(async (galleryId: number, title: string) => {
    const { exportGalleryZip } = await import('@/lib/utils/download-zip');
    await exportGalleryZip(galleryId, title);
  }, []);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          {t('library.title')}
          {!activeLoading && (
            <span className="ml-2 text-lg font-normal text-zinc-500">
              ({totalCount.toLocaleString()})
            </span>
          )}
        </h1>
        <StorageIndicator />
      </div>

      {/* Search bar — AC-006 */}
      <div className="mb-4">
        <SearchInputSimple
          value={rawQuery}
          onChange={handleQueryChange}
          placeholder={t('library.search.placeholder')}
        />
      </div>

      {activeLoading ? (
        <div className="flex justify-center py-12"><Spinner size="md" /></div>
      ) : totalCount === 0 ? (
        <p className="text-zinc-500 dark:text-zinc-400">
          {hasQuery ? t('search.noResults') : t('library.empty')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {(activeItems ?? []).map((item) => (
            <LibraryCard
              key={item.galleryId}
              item={item}
              onDelete={handleDelete}
              onExport={handleExport}
            />
          ))}
        </div>
      )}
    </>
  );
}
