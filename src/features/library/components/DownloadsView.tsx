'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Spinner } from '@/shared/components/Spinner';
import { AbortableImage } from '@/shared/components/AbortableImage';
import { TagChip } from '@/shared/components/TagChip';
import { useT } from '@/lib/i18n/useT';
import { useTagI18n } from '@/lib/i18n/useTagI18n';
import { listDownloads, searchDownloads, deleteDownload, deserializeTags } from '@/lib/db/download';
import { createDownloadStore, DownloadCancelledError } from '@/lib/storage/download-store';
import { resolveThumbnailUrl } from '@/lib/api/url-resolver';
import type { DBDownload } from '@/lib/db/schema';
import type { TagType } from '@/lib/utils/types';
import { galleryHref } from '@/lib/utils/routes';
import { getGgConfig } from '@/lib/api/client';
import { resolveGalleryDetail } from '@/features/gallery-detail/hooks/useGalleryDetail';
import { downloadGalleryToLibrary, type DownloadProgress } from '@/lib/utils/download-zip';

// Match the gallery-list grid (GalleryGrid GRID_AUTO) so downloaded items read
// as the same cover-forward cards.
const GRID_CLASS =
  '-mx-2 grid grid-cols-2 gap-x-2 gap-y-2.5 sm:mx-0 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Cover status badge — a small overlay on the card cover (not a button row).
// Only downloading/failed surface a badge; a complete card stays clean.
// ---------------------------------------------------------------------------

function CoverBadge({
  status,
  progressLabel,
}: {
  status: DBDownload['status'];
  progressLabel?: string | null;
}) {
  const t = useT();
  if (status === 'complete') return null;

  const isDownloading = status === 'downloading';
  const colorClass = isDownloading ? 'bg-blue-600/90 text-white' : 'bg-red-600/90 text-white';
  const label = isDownloading
    ? (progressLabel ?? t('library.status.downloading'))
    : t('library.status.failed');

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold shadow-sm backdrop-blur-sm ${colorClass}`}
    >
      {isDownloading && <Spinner size="sm" />}
      {label}
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

interface MenuAction {
  key: string;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}

/**
 * Kebab (⋯) overflow menu shown on the card cover. Holds every secondary action
 * (Export / Retry / Delete) so the card face stays a clean cover, matching the
 * gallery-list card. Closes on outside click. Renders nothing when empty.
 */
function OverflowMenu({ label, items }: { label: string; items: MenuAction[] }) {
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

  if (items.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white shadow-sm backdrop-blur-sm active:bg-black/70 sm:hover:bg-black/70"
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
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); it.onClick(); }}
              className={`block w-full px-4 py-2.5 text-left text-sm font-medium ${
                it.destructive
                  ? 'text-red-600 hover:bg-red-50 active:bg-red-50 dark:text-red-400 dark:hover:bg-red-950 dark:active:bg-red-950'
                  : 'text-zinc-700 hover:bg-zinc-50 active:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800 dark:active:bg-zinc-800'
              }`}
            >
              {it.label}
            </button>
          ))}
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
  const showDownloading = item.status === 'downloading' || isRetrying;

  // Prefer the locally downloaded first page (offline, no network) and fall back
  // to the network thumbnail when there is no local file (or on web).
  const localCover = useDownloadedCoverUrl(item.galleryId);
  const coverSrc = localCover ?? (item.thumbnail ? resolveThumbnailUrl(item.thumbnail) : null);

  // Build display tags from the stored tag map, mirroring GalleryCard ordering
  // (uncensored first, then artist/group, then the rest).
  const tagEntries = useMemo(
    () => Object.entries(deserializeTags(item.tags)) as [TagType, string[]][],
    [item.tags],
  );
  const tagI18n = useTagI18n(tagEntries);
  const displayTags = useMemo(() => {
    const all: { tag: string; type: TagType; priority: number }[] = [];
    for (const [type, tags] of tagEntries) {
      for (const tag of tags || []) {
        let priority: number;
        if (tag === 'uncensored') priority = 0;
        else if (type === 'artist' || type === 'group') priority = 1;
        else priority = 2;
        all.push({ tag, type, priority });
      }
    }
    all.sort((a, b) => a.priority - b.priority);
    return all;
  }, [tagEntries]);

  const progressLabel = retryProgress ? `${retryProgress.current}/${retryProgress.total}` : null;

  // Secondary actions live in the ⋯ menu, never as an inline button row.
  const menuItems = useMemo<MenuAction[]>(() => {
    const items: MenuAction[] = [];
    if (isFailed) {
      items.push({ key: 'retry', label: t('library.retry'), onClick: () => onRetry(item) });
    }
    if (item.status === 'complete') {
      items.push({ key: 'export', label: t('library.exportZip'), onClick: () => onExport(item.galleryId, item.title) });
    }
    items.push({ key: 'delete', label: t('library.delete'), onClick: () => onDelete(item.galleryId), destructive: true });
    return items;
  }, [isFailed, item, t, onRetry, onExport, onDelete]);

  return (
    <div className="group relative">
      <Link href={galleryHref(item.galleryId)} className="block touch-manipulation" draggable={false}>
        <div className="relative aspect-[2/3] overflow-hidden rounded-2xl bg-zinc-100 shadow-sm transition-transform active:scale-[0.985] sm:rounded-lg sm:shadow-none dark:bg-zinc-800 sm:hover:shadow-lg">
          {coverSrc ? (
            <AbortableImage
              src={coverSrc}
              alt={item.title}
              draggable={false}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-zinc-400">
              #{item.galleryId}
            </div>
          )}

          {/* Status overlay (top-left) — a badge, not buttons. */}
          {(showDownloading || isFailed) && (
            <div className="absolute left-1.5 top-1.5">
              <CoverBadge status={isFailed ? 'failed' : 'downloading'} progressLabel={progressLabel} />
            </div>
          )}

          {/* Title + tags in a gradient overlay — same shape as GalleryCard. */}
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-6 sm:from-black/95 sm:via-black/70 sm:pt-10">
            <div className="px-2.5 pb-2.5 pt-1.5 backdrop-blur-sm sm:px-2 sm:pb-2 sm:pt-1.5">
              <h3 className="line-clamp-2 text-[13px] font-semibold leading-tight text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.8)] sm:text-sm sm:leading-tight">
                {item.title || `#${item.galleryId}`}
              </h3>
              {displayTags.length > 0 && (
                <div className="mt-1 flex max-h-[22px] flex-wrap gap-1 overflow-hidden md:max-h-[44px]">
                  {displayTags.map(({ tag, type }) => (
                    <TagChip
                      key={`${type}-${tag}`}
                      tag={tag}
                      type={type}
                      displayName={tagI18n.get(`${type}:${tag}`)}
                      linked={false}
                      size="sm"
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </Link>

      {/* Overflow menu — sibling of the Link so taps don't navigate. Hidden mid-retry. */}
      {!isRetrying && (
        <div className="absolute right-1.5 top-1.5">
          <OverflowMenu label={t('library.more')} items={menuItems} />
        </div>
      )}
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
        <div className={GRID_CLASS}>
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
