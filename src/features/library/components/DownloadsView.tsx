'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Spinner } from '@/shared/components/Spinner';
import { AbortableImage } from '@/shared/components/AbortableImage';
import { useT } from '@/lib/i18n/useT';
import { listDownloads, searchDownloads, deleteDownload, deserializeTags } from '@/lib/db/download';
import { createDownloadStore, DownloadCancelledError } from '@/lib/storage/download-store';
import { resolveThumbnailUrl } from '@/lib/api/url-resolver';
import type { DBDownload } from '@/lib/db/schema';
import { galleryHref } from '@/lib/utils/routes';
import { getGgConfig } from '@/lib/api/client';
import { resolveGalleryDetail } from '@/features/gallery-detail/hooks/useGalleryDetail';
import { downloadGalleryToLibrary, type DownloadProgress } from '@/lib/utils/download-zip';

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
  onRetry: (item: DBDownload) => void;
  isRetrying: boolean;
  retryProgress: DownloadProgress | null;
}

/**
 * Kebab (⋯) overflow menu. Holds the destructive Delete action so it is no
 * longer one mis-tap away from Open/Export. Closes on outside click.
 */
function OverflowMenu({ label, deleteLabel, onDelete }: {
  label: string;
  deleteLabel: string;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocPointer);
    return () => document.removeEventListener('mousedown', onDocPointer);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-xl border border-zinc-300 text-zinc-500 active:bg-zinc-50 sm:min-h-9 sm:min-w-9 sm:rounded-md sm:hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:active:bg-zinc-800 sm:dark:hover:bg-zinc-800"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4" aria-hidden="true">
          <path d="M8 4a1 1 0 110-2 1 1 0 010 2zm0 5a1 1 0 110-2 1 1 0 010 2zm0 5a1 1 0 110-2 1 1 0 010 2z" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 min-w-32 overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onDelete(); }}
            className="block w-full px-4 py-2.5 text-left text-sm font-medium text-red-600 hover:bg-red-50 active:bg-red-50 dark:text-red-400 dark:hover:bg-red-950 dark:active:bg-red-950"
          >
            {deleteLabel}
          </button>
        </div>
      )}
    </div>
  );
}

/** A WebView file URL for the gallery's downloaded first page, used as an offline
 *  cover. null on web / when nothing is downloaded → caller uses the network thumb. */
function useDownloadedCoverUrl(galleryId: number): string | null {
  const { data } = useQuery({
    queryKey: ['download-cover', galleryId],
    queryFn: async () => {
      const store = await createDownloadStore();
      return (await store.coverUrl?.(galleryId)) ?? null;
    },
    staleTime: Infinity,
  });
  return data ?? null;
}

function LibraryCard({ item, onDelete, onExport, onRetry, isRetrying, retryProgress }: LibraryCardProps) {
  const t = useT();
  const isFailed = item.status === 'failed';
  // Prefer the locally downloaded first page (offline, no network) and fall back
  // to the network thumbnail when there is no local file (or on web).
  const localCover = useDownloadedCoverUrl(item.galleryId);
  const coverSrc = localCover ?? (item.thumbnail ? resolveThumbnailUrl(item.thumbnail) : null);

  return (
    <div className="flex gap-4 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:rounded-lg dark:border-zinc-800 dark:bg-zinc-900">
      {/* Thumbnail */}
      <div className="h-32 w-[5.35rem] shrink-0 overflow-hidden rounded-xl bg-zinc-100 sm:h-24 sm:w-16 sm:rounded-md dark:bg-zinc-800">
        {coverSrc ? (
          <AbortableImage
            src={coverSrc}
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
          <h3 className="line-clamp-2 text-base font-semibold leading-snug text-zinc-900 sm:text-sm dark:text-zinc-100">
            {item.title || `#${item.galleryId}`}
          </h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-zinc-500 sm:mt-1 sm:text-xs dark:text-zinc-400">
            <span>{item.pageCount} {t('library.pages')}</span>
            <span>{formatBytes(item.totalBytes)}</span>
            <span>{formatDate(item.downloadedAt)}</span>
            <StatusBadge status={item.status} />
          </div>
          {isFailed && item.lastError && (
            <p className="mt-1.5 line-clamp-2 text-xs text-red-600 dark:text-red-400">
              {t('library.errorPrefix')}: {item.lastError}
            </p>
          )}
        </div>

        {/* Actions. Delete lives in the ⋯ menu so it is not one mis-tap from Open. */}
        <div className="flex flex-wrap items-center gap-2">
          {isFailed ? (
            isRetrying ? (
              <span className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-zinc-100 px-4 text-sm font-medium text-zinc-600 sm:min-h-0 sm:rounded-md sm:px-3 sm:py-1.5 sm:text-xs dark:bg-zinc-800 dark:text-zinc-300">
                <Spinner size="sm" />
                {retryProgress ? `${retryProgress.current}/${retryProgress.total}` : t('library.retrying')}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onRetry(item)}
                className="inline-flex min-h-10 items-center rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white active:bg-zinc-700 sm:min-h-0 sm:rounded-md sm:px-3 sm:py-1.5 sm:text-xs sm:font-medium sm:hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:active:bg-zinc-300 sm:dark:hover:bg-zinc-300"
              >
                {t('library.retry')}
              </button>
            )
          ) : (
            <Link
              href={galleryHref(item.galleryId)}
              className="inline-flex min-h-10 items-center rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white active:bg-zinc-700 sm:min-h-0 sm:rounded-md sm:px-3 sm:py-1.5 sm:text-xs sm:font-medium sm:hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:active:bg-zinc-300 sm:dark:hover:bg-zinc-300"
            >
              {t('library.open')}
            </Link>
          )}
          {/* Failed-but-partial galleries can still be opened to read what landed. */}
          {isFailed && item.pageCount > 0 && !isRetrying && (
            <Link
              href={galleryHref(item.galleryId)}
              className="inline-flex min-h-10 items-center rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 active:bg-zinc-50 sm:min-h-0 sm:rounded-md sm:px-3 sm:py-1.5 sm:text-xs sm:font-medium sm:hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:active:bg-zinc-800 sm:dark:hover:bg-zinc-800"
            >
              {t('library.open')}
            </Link>
          )}
          {item.status === 'complete' && (
            <button
              type="button"
              onClick={() => onExport(item.galleryId, item.title)}
              className="inline-flex min-h-10 items-center rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 active:bg-zinc-50 sm:min-h-0 sm:rounded-md sm:px-3 sm:py-1.5 sm:text-xs sm:font-medium sm:hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:active:bg-zinc-800 sm:dark:hover:bg-zinc-800"
            >
              {t('library.exportZip')}
            </button>
          )}
          {!isRetrying && (
            <OverflowMenu
              label={t('library.more')}
              deleteLabel={t('library.delete')}
              onDelete={() => onDelete(item.galleryId)}
            />
          )}
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
          type="button"
          onClick={() => onChange('')}
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
// Main view
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 250;

export function DownloadsView({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [rawQuery, setRawQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Foreground retry (resume) state — one item at a time.
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [retryProgress, setRetryProgress] = useState<DownloadProgress | null>(null);

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

  // Retry a failed download by RESUMING it: re-fetch the gallery's file list
  // (not stored on the row) + gg config, then download only the missing pages.
  // download-zip updates the row's status/lastError; we just refresh on finish.
  const handleRetry = useCallback(async (item: DBDownload) => {
    if (retryingId !== null) return; // one retry at a time
    setRetryingId(item.galleryId);
    setRetryProgress(null);
    try {
      const [{ files }, config] = await Promise.all([
        resolveGalleryDetail(item.galleryId),
        getGgConfig(),
      ]);
      await downloadGalleryToLibrary(
        item.galleryId,
        item.title,
        item.thumbnail,
        files,
        config,
        deserializeTags(item.tags),
        setRetryProgress,
        undefined,
        { resume: true },
      );
    } catch (e) {
      // Cancels are silent. Genuine failures already wrote lastError onto the
      // row inside download-zip; the query refresh below surfaces the new reason.
      if (!(e instanceof DownloadCancelledError) && !(e instanceof DOMException && e.name === 'AbortError')) {
        console.error('Retry failed:', e);
      }
    } finally {
      setRetryingId(null);
      setRetryProgress(null);
      queryClient.invalidateQueries({ queryKey: ['library-list'] });
      queryClient.invalidateQueries({ queryKey: ['library-search'] });
    }
  }, [retryingId, queryClient]);

  const showSearchBar = !activeLoading && (totalCount > 0 || hasQuery);

  return (
    <>
      {!embedded && (
        <div className="mb-5 flex flex-wrap items-baseline gap-3">
          <h1 className="text-[2rem] font-bold leading-tight text-zinc-900 sm:text-2xl dark:text-zinc-100">
            {t('library.title')}
            {!activeLoading && (
              <span className="ml-2 text-xl font-normal text-zinc-500 sm:text-lg">
                ({totalCount.toLocaleString()})
              </span>
            )}
          </h1>
          <StorageIndicator />
        </div>
      )}

      {/* Search bar — hidden when library is empty and no query active. */}
      {showSearchBar && (
        <div className="mb-4">
          <SearchInputSimple
            value={rawQuery}
            onChange={handleQueryChange}
            placeholder={t('library.search.placeholder')}
          />
        </div>
      )}

      {activeLoading ? (
        <div className="flex justify-center py-12"><Spinner size="md" /></div>
      ) : totalCount === 0 ? (
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-14 w-14 text-zinc-300 dark:text-zinc-700" aria-hidden="true">
            <path d="M4 4h4v16H4zM10 4h4v16h-4zM18 4l2 16-2 .25" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="max-w-xs text-sm text-zinc-500 dark:text-zinc-400">
            {hasQuery ? t('search.noResults') : t('library.empty')}
          </p>
          {!hasQuery && (
            <Link
              href="/"
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {t('empty.browseGalleries')}
            </Link>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4 sm:gap-3">
          {(activeItems ?? []).map((item) => (
            <LibraryCard
              key={item.galleryId}
              item={item}
              onDelete={handleDelete}
              onExport={handleExport}
              onRetry={handleRetry}
              isRetrying={retryingId === item.galleryId}
              retryProgress={retryingId === item.galleryId ? retryProgress : null}
            />
          ))}
        </div>
      )}
    </>
  );
}
