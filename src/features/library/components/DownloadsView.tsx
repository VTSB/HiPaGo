'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Spinner } from '@/shared/components/Spinner';
import { AbortableImage } from '@/shared/components/AbortableImage';
import { TagChip } from '@/shared/components/TagChip';
import { DownloadQueueView } from '@/features/library/components/DownloadQueueView';
import { useT } from '@/lib/i18n/useT';
import { useTagI18n } from '@/lib/i18n/useTagI18n';
import {
  listLibraryDownloads,
  searchDownloads,
  deleteDownload,
  deserializeTags,
} from '@/lib/db/download';
import { enqueueDownload } from '@/lib/db/download-queue';
import { clearAutoRetry, AUTO_RETRY_MAX } from '@/lib/db/download-retry';
import {
  DOWNLOAD_LIBRARY_CHANGED_EVENT,
  processQueue,
  useDownloadProgressStore,
} from '@/lib/store/download-progress';
import { createDownloadStore } from '@/lib/storage/download-store';
import { resolveThumbnailUrl } from '@/lib/api/url-resolver';
import type { DBDownload } from '@/lib/db/schema';
import type { TagType } from '@/lib/utils/types';
import { galleryHref } from '@/lib/utils/routes';
import { hasCompleteDownloadedGallery, type DownloadProgress } from '@/lib/utils/download-zip';

// Match the gallery-list grid (GalleryGrid GRID_AUTO) so downloaded items read
// as the same cover-forward cards.
const GRID_CLASS =
  '-mx-2 grid grid-cols-2 gap-x-2 gap-y-2.5 sm:mx-0 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5';
const LAST_LIST_URL_KEY = 'hipago:last-list-url';
const INITIAL_RENDER_COUNT = 80;
const RENDER_BATCH_SIZE = 80;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function progressPercent(progress: DownloadProgress): number {
  if (progress.total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((progress.current / progress.total) * 100)));
}

// ---------------------------------------------------------------------------
// Cover status badge — a small overlay on the card cover (not a button row).
// Only downloading/failed surface a badge; a complete card stays clean.
// ---------------------------------------------------------------------------

function CoverBadge({
  status,
  progressLabel,
  autoRetryLabel,
}: {
  status: DBDownload['status'];
  progressLabel?: string | null;
  /** When set on a failed row, shows the staged-auto-restart annotation
   *  ("Auto-retry in <time> (attempt k/3)") in amber instead of a red Failed. */
  autoRetryLabel?: string | null;
}) {
  const t = useT();
  if (status === 'complete') return null;

  const isDownloading = status === 'downloading';
  const isAutoRetry = !isDownloading && !!autoRetryLabel;
  const colorClass = isDownloading
    ? 'bg-blue-600/90 text-white'
    : isAutoRetry
      ? 'bg-amber-500/90 text-white'
      : 'bg-red-600/90 text-white';
  const label = isDownloading
    ? (progressLabel ?? t('library.status.downloading'))
    : isAutoRetry
      ? autoRetryLabel
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

/**
 * Format an ISO due-time into a short relative string ("30s", "5m") using the
 * localized minute/second units. Returns null when the row is not awaiting an
 * auto-retry (no future nextRetryAt, or the attempt cap is exhausted).
 */
function useAutoRetryLabel(item: DBDownload): string | null {
  const t = useT();
  const nextRetryAt = item.nextRetryAt;
  const retryCount = item.retryCount ?? 0;
  const pending = item.status === 'failed' && !!nextRetryAt && retryCount <= AUTO_RETRY_MAX;

  // Tick `now` every second so the countdown updates. Date.now() / setNow are
  // called only inside timer callbacks (never synchronously in render or the
  // effect body) to satisfy react-hooks purity + set-state-in-effect rules.
  const [now, setNow] = useState<number>(0);
  useEffect(() => {
    if (!pending) return;
    const prime = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(prime);
      clearInterval(id);
    };
  }, [pending]);

  // now === 0 means the priming tick has not run yet (first paint); show the
  // plain failed badge until the next frame supplies a real clock reading.
  if (!pending || !nextRetryAt || now === 0) return null;

  const msLeft = new Date(nextRetryAt).getTime() - now;
  let timeStr: string;
  if (msLeft <= 0) {
    return (
      t('library.retry.now') +
      ` (${t('library.retry.attempt').replace('{k}', String(retryCount)).replace('{max}', String(AUTO_RETRY_MAX))})`
    );
  }
  const totalSec = Math.ceil(msLeft / 1000);
  if (totalSec >= 60) {
    const min = Math.ceil(totalSec / 60);
    timeStr = `${min}${t('library.retry.unit.minute')}`;
  } else {
    timeStr = `${totalSec}${t('library.retry.unit.second')}`;
  }
  const inStr = t('library.retry.autoIn').replace('{time}', timeStr);
  const attemptStr = t('library.retry.attempt')
    .replace('{k}', String(retryCount))
    .replace('{max}', String(AUTO_RETRY_MAX));
  return `${inStr} (${attemptStr})`;
}

// ---------------------------------------------------------------------------
// Per-item gallery card for the library list
// ---------------------------------------------------------------------------

interface LibraryCardProps {
  item: DBDownload;
  localCoverUrl?: string | null;
  onDelete: (item: DBDownload) => void;
  onExport: (galleryId: number, title: string) => void;
  onRetry: (item: DBDownload) => void;
  isRetrying: boolean;
  retryProgress: DownloadProgress | null;
  /** Live "auto-retry pending" state from the store, fresher than the DB row on
   *  a just-failed item (the library-list query may not have refetched yet). */
  retryOverride?: { retryAt?: string | null; attempt?: number | null } | null;
  isMissingFiles?: boolean;
  canExport?: boolean;
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
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          fill="currentColor"
          className="h-4 w-4"
          aria-hidden="true"
        >
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
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
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

function LibraryCard({
  item,
  localCoverUrl,
  onDelete,
  onExport,
  onRetry,
  isRetrying,
  retryProgress,
  retryOverride,
  isMissingFiles = false,
  canExport = false,
}: LibraryCardProps) {
  const t = useT();
  const effectiveStatus: DBDownload['status'] =
    item.status === 'complete' && isMissingFiles ? 'failed' : item.status;
  const isFailed = effectiveStatus === 'failed';
  const showDownloading = item.status === 'downloading' || isRetrying;

  // The live store entry (retryOverride) is fresher than the DB row on a
  // just-failed item, so prefer it for the auto-retry annotation.
  const effectiveItem: DBDownload = retryOverride?.retryAt
    ? {
        ...item,
        nextRetryAt: retryOverride.retryAt,
        retryCount: retryOverride.attempt ?? item.retryCount,
      }
    : item;
  const autoRetryLabel = useAutoRetryLabel(effectiveItem);

  // Prefer the locally downloaded first page (offline, no network) and fall back
  // to the network thumbnail when there is no local file (or on web).
  const coverSrc = localCoverUrl ?? (item.thumbnail ? resolveThumbnailUrl(item.thumbnail) : null);

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

  const progressLabel = retryProgress
    ? `${retryProgress.current}/${retryProgress.total} · ${progressPercent(retryProgress)}%`
    : null;
  const rememberCurrentListUrl = useCallback(() => {
    try {
      const url = window.location.pathname + window.location.search;
      sessionStorage.setItem(LAST_LIST_URL_KEY, url);
    } catch {
      // History/session storage can be unavailable in private/embedded contexts.
    }
  }, []);

  // Secondary actions live in the ⋯ menu, never as an inline button row.
  const menuItems = useMemo<MenuAction[]>(() => {
    const items: MenuAction[] = [];
    if (isFailed) {
      items.push({ key: 'retry', label: t('library.retry'), onClick: () => onRetry(item) });
    }
    if (effectiveStatus === 'complete' && canExport) {
      items.push({
        key: 'export',
        label: t('library.exportZip'),
        onClick: () => onExport(item.galleryId, item.title),
      });
    }
    items.push({
      key: 'delete',
      label: t('library.delete'),
      onClick: () => onDelete(item),
      destructive: true,
    });
    return items;
  }, [canExport, effectiveStatus, isFailed, item, t, onRetry, onExport, onDelete]);

  return (
    <div className="group relative">
      <Link
        href={galleryHref(item.galleryId)}
        className="block touch-manipulation"
        draggable={false}
        onClick={rememberCurrentListUrl}
      >
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
              <CoverBadge
                status={isFailed ? 'failed' : 'downloading'}
                progressLabel={progressLabel}
                autoRetryLabel={isFailed && !isRetrying ? autoRetryLabel : null}
              />
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
      .then((bytes) => {
        if (!cancelled) setUsageBytes(bytes);
      })
      .catch(() => {
        /* storage unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (usageBytes === null) return null;

  return (
    <p className="text-sm text-zinc-500 dark:text-zinc-400">
      {t('library.storageUsed')}:{' '}
      <span className="font-medium text-zinc-700 dark:text-zinc-300">
        {formatBytes(usageBytes)}
      </span>
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
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const [renderLimit, setRenderLimit] = useState(INITIAL_RENDER_COUNT);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportingIdsRef = useRef<Set<number>>(new Set());
  // Live per-gallery download progress from the queue processor (store). The
  // processor is the SOLE download authority now — no second single-flight here.
  const storeEntries = useDownloadProgressStore((s) => s.entries);
  const downloadedFlags = useDownloadProgressStore((s) => s.downloaded);
  const hasQueuedWork = useDownloadProgressStore((s) => s.queue.length > 0);
  const refreshQueue = useDownloadProgressStore((s) => s.refreshQueue);

  const handleQueryChange = useCallback((v: string) => {
    setRawQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(v), DEBOUNCE_MS);
  }, []);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  useEffect(() => {
    const onLibraryChanged = () => {
      void queryClient.invalidateQueries({ queryKey: ['library-list'] });
      void queryClient.invalidateQueries({ queryKey: ['library-search'] });
      void queryClient.invalidateQueries({ queryKey: ['download-integrity'] });
      void queryClient.invalidateQueries({ queryKey: ['download-covers'] });
    };
    window.addEventListener(DOWNLOAD_LIBRARY_CHANGED_EVENT, onLibraryChanged);
    return () => window.removeEventListener(DOWNLOAD_LIBRARY_CHANGED_EVENT, onLibraryChanged);
  }, [queryClient]);

  const hasQuery = debouncedQuery.trim().length > 0;

  const { data: allItems, isLoading } = useQuery({
    queryKey: ['library-list'],
    queryFn: () => listLibraryDownloads(),
    staleTime: 0,
  });

  // Search shares the library surface, so exclude queue-only states here too —
  // keeps the searched list visually identical to the unfiltered library list.
  const { data: filteredItems, isLoading: isFilterLoading } = useQuery({
    queryKey: ['library-search', debouncedQuery],
    queryFn: async () => {
      const rows = await searchDownloads({ query: debouncedQuery });
      return rows.filter(
        (r) => r.status === 'complete' || r.status === 'downloading' || r.status === 'failed',
      );
    },
    enabled: hasQuery,
    staleTime: 0,
  });

  const activeItems = hasQuery ? filteredItems : allItems;
  const activeLoading = hasQuery ? isFilterLoading : isLoading;

  const totalCount = activeItems?.length ?? 0;
  const visibleItems = useMemo(
    () => (activeItems ?? []).slice(0, renderLimit),
    [activeItems, renderLimit],
  );
  const visibleGalleryIds = useMemo(
    () => visibleItems.map((item) => item.galleryId),
    [visibleItems],
  );
  const hasMoreRenderedItems = renderLimit < totalCount;

  const { data: coverUrls = {} } = useQuery({
    queryKey: ['download-covers', visibleGalleryIds],
    queryFn: async () => {
      const store = await createDownloadStore();
      if (!store.coverUrl) return {};
      const pairs = await Promise.all(
        visibleGalleryIds.map(async (id) => [id, await store.coverUrl?.(id)] as const),
      );
      return Object.fromEntries(pairs.filter(([, url]) => !!url)) as Record<number, string>;
    },
    enabled: visibleGalleryIds.length > 0,
    staleTime: Infinity,
  });

  const completeVisibleItems = useMemo(
    () => visibleItems.filter((item) => item.status === 'complete'),
    [visibleItems],
  );
  const completeIntegrityKey = useMemo(
    () => completeVisibleItems.map((item) => `${item.galleryId}:${item.pageCount}`).join('|'),
    [completeVisibleItems],
  );

  const { data: completeIntegrity = {} } = useQuery({
    queryKey: ['download-integrity', completeIntegrityKey],
    queryFn: async () => {
      const pairs = await Promise.all(
        completeVisibleItems.map(async (item) => {
          const ok =
            (item.pageCount ?? 0) > 0
              ? await hasCompleteDownloadedGallery(item.galleryId, item.pageCount).catch(
                  () => false,
                )
              : false;
          return [item.galleryId, ok] as const;
        }),
      );
      return Object.fromEntries(pairs) as Record<number, boolean>;
    },
    enabled: completeVisibleItems.length > 0,
    staleTime: 0,
  });

  useEffect(() => {
    setRenderLimit(INITIAL_RENDER_COUNT);
  }, [debouncedQuery]);

  useEffect(() => {
    if (!hasMoreRenderedItems) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const node = loadMoreRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setRenderLimit((n) => Math.min(n + RENDER_BATCH_SIZE, totalCount));
      },
      { rootMargin: '900px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMoreRenderedItems, totalCount]);

  // Delete handler: remove DB row + DownloadStore files, then invalidate queries
  const handleDelete = useCallback(
    async (item: DBDownload) => {
      if (!window.confirm(t('library.confirmDelete'))) return;
      const galleryId = item.galleryId;
      try {
        const liveEntry = useDownloadProgressStore.getState().entries[galleryId];
        if (item.status === 'downloading' || !!liveEntry?.progress) {
          await useDownloadProgressStore.getState().cancel(galleryId);
        }
        if (item.status === 'failed' && (item.nextRetryAt || liveEntry?.retryAt)) {
          await clearAutoRetry(galleryId).catch(() => {});
          useDownloadProgressStore.getState().clearRetryPending(galleryId);
        }
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
    },
    [t, queryClient],
  );

  // Export a downloaded gallery's stored images back out as a ZIP.
  const handleExport = useCallback(
    async (galleryId: number, title: string) => {
      if (exportingIdsRef.current.has(galleryId)) return;
      exportingIdsRef.current.add(galleryId);
      setExportError(null);
      try {
        const { exportGalleryZip } = await import('@/lib/utils/download-zip');
        await exportGalleryZip(galleryId, title);
      } catch (e) {
        console.error('Export failed:', e);
        setExportError(t('library.exportFailed'));
        void queryClient.invalidateQueries({ queryKey: ['library-list'] });
        void queryClient.invalidateQueries({ queryKey: ['library-search'] });
      } finally {
        exportingIdsRef.current.delete(galleryId);
      }
    },
    [t, queryClient],
  );

  // Retry a failed download by RESUMING it THROUGH THE QUEUE: enqueue the row
  // (userInitiated → front of queue) and kick the processor. The processor
  // re-fetches the gallery's file list (not stored on the row), resumes from the
  // partial pages, and pushes live progress into the store. This unifies retry
  // with the single download authority — no separate single-flight here.
  const handleRetry = useCallback(
    async (item: DBDownload) => {
      // The processor already single-flights per gallery; a live entry means it's
      // in flight, so ignore a duplicate tap.
      if (storeEntries[item.galleryId]?.progress) return;
      try {
        // Manual retry resets the auto-restart attempt counter — a fresh set of
        // automatic attempts thereafter. enqueueDownload (default path) also
        // resets it, but clear explicitly so the reset holds even if the enqueue
        // is later changed, and clear the store's "retry pending" entry now.
        await clearAutoRetry(item.galleryId);
        await enqueueDownload(
          {
            galleryId: item.galleryId,
            title: item.title,
            thumbnail: item.thumbnail,
            tags: deserializeTags(item.tags),
          },
          { userInitiated: true },
        );
        useDownloadProgressStore.getState().clearRetryPending(item.galleryId);
        void refreshQueue();
        void processQueue({ onlyGalleryId: item.galleryId });
      } catch (e) {
        console.error('Retry failed to enqueue:', e);
      } finally {
        queryClient.invalidateQueries({ queryKey: ['library-list'] });
        queryClient.invalidateQueries({ queryKey: ['library-search'] });
        queryClient.invalidateQueries({ queryKey: ['download-integrity'] });
      }
    },
    [storeEntries, queryClient, refreshQueue],
  );

  const showSearchBar = !activeLoading && (totalCount > 0 || hasQuery);
  const showQueueOnly = !hasQuery && totalCount === 0 && hasQueuedWork;

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

      {/* Download manager — active + queued/paused items, ABOVE the completed
          list. Hidden (renders null) when nothing is active or queued. */}
      <DownloadQueueView />

      {exportError && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
        >
          {exportError}
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
        <div className="flex justify-center py-12">
          <Spinner size="md" />
        </div>
      ) : totalCount === 0 && !showQueueOnly ? (
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
              d="M4 4h4v16H4zM10 4h4v16h-4zM18 4l2 16-2 .25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
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
      ) : showQueueOnly ? null : (
        <div className={GRID_CLASS}>
          {visibleItems.map((item) => {
            const entry = storeEntries[item.galleryId];
            const progress = entry?.progress ?? null;
            const activeRedownload =
              item.status === 'complete' && downloadedFlags[item.galleryId] === false;
            const staleCompleteProgress =
              item.status === 'complete' && !activeRedownload;
            const isRetrying = !!progress && !staleCompleteProgress;
            return (
              <LibraryCard
                key={item.galleryId}
                item={item}
                localCoverUrl={coverUrls[item.galleryId] ?? null}
                onDelete={handleDelete}
                onExport={handleExport}
                onRetry={handleRetry}
                isRetrying={isRetrying}
                retryProgress={isRetrying ? progress : null}
                retryOverride={
                  entry?.retryAt ? { retryAt: entry.retryAt, attempt: entry.attempt } : null
                }
                isMissingFiles={
                  item.status === 'complete' && completeIntegrity[item.galleryId] === false
                }
                canExport={item.status === 'complete' && completeIntegrity[item.galleryId] === true}
              />
            );
          })}
          {hasMoreRenderedItems && <div ref={loadMoreRef} className="col-span-full h-8" />}
        </div>
      )}
    </>
  );
}
