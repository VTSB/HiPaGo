'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useGalleryDetail } from '@/features/gallery-detail/hooks/useGalleryDetail';
import { GalleryBlockType, TagType } from '@/lib/utils/types';
import { GalleryCardById } from '@/features/gallery-list/components/GalleryCard';
import { getThumbnailUrl } from '@/lib/utils/image-url';
import { AbortableImage } from '@/shared/components/AbortableImage';
import { resolveThumbnailUrl } from '@/lib/api/url-resolver';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { getDetailEntryThumbnail } from '@/features/gallery-detail/utils/detailEntryThumbnail';
import { recordVisit } from '@/lib/db/gallery';
import { Spinner } from '@/shared/components/Spinner';
import { BackBar } from '@/shared/components/BackBar';
import { useT } from '@/lib/i18n/useT';
import { useTagI18n, useTagLocalName } from '@/lib/i18n/useTagI18n';
import { useGalleryBlock } from '@/features/gallery-list/hooks/useGalleryBlock';
import { getGgConfig } from '@/lib/api/client';
import type { GalleryBlock } from '@/lib/utils/types';
import { useFavoriteToggle } from '@/features/gallery-detail/hooks/useFavoriteToggle';
import { useDownloadGallery } from '@/features/gallery-detail/hooks/useDownloadGallery';
import { useDownloadedFilesPresent } from '@/features/gallery-detail/hooks/useDownloadedFilesPresent';
import { readerHref } from '@/lib/utils/routes';
import { TagFavoriteChip } from '@/shared/components/TagFavoriteChip';
import { useSettingsStore } from '@/lib/store/settings';
import { prioritizeFavorites, toFavoriteTagKey } from '@/lib/utils/tag-favorites';

const INITIAL_THUMBNAILS = 20;
const LOAD_MORE_COUNT = 20;
const LAST_LIST_URL_KEY = 'hipago:last-list-url';

const TAG_ORDER: Record<string, number> = {
  [TagType.ARTIST]: 0,
  [TagType.GROUP]: 1,
  [TagType.SERIES]: 2,
  [TagType.CHARACTER]: 3,
  [TagType.FEMALE]: 4,
  [TagType.MALE]: 5,
  [TagType.TAG]: 6,
};

export function GalleryDetail({ id }: { id: number }) {
  const { block, files, isLoading, error } = useGalleryDetail(id);
  // Use cached block from list page as instant preview while full info loads
  const cachedBlock = useGalleryBlock(id);
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [renderState, setRenderState] = useState({ id, count: INITIAL_THUMBNAILS });
  const sentinelRef = useRef<HTMLDivElement>(null);
  const t = useT();
  const favoriteTags = useSettingsStore((state) => state.favoriteTags ?? []);
  const renderedCount = renderState.id === id ? renderState.count : INITIAL_THUMBNAILS;
  const backTargetRef = useRef('/');

  const cameFromListRef = useRef(false);

  const goBackToList = useCallback(() => {
    // Prefer a real back navigation so the browser restores scroll on the
    // list entry. Only fall back to a fresh navigate when there's no list
    // origin in this tab's history (direct URL entry).
    if (cameFromListRef.current && window.history.length > 1) {
      window.history.back();
      return;
    }
    router.replace(backTargetRef.current || '/');
  }, [router]);

  useEffect(() => {
    recordVisit(id).catch((e) => console.warn('[detail] Visit record failed:', e));
    // Warm gg.js cache so reader opens instantly
    getGgConfig().catch((e) => console.warn('[detail] GgConfig warm failed:', e));
  }, [id]);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(LAST_LIST_URL_KEY);
      if (stored && !stored.startsWith('/gallery') && !stored.startsWith('/reader')) {
        backTargetRef.current = stored;
        cameFromListRef.current = true;
      }
    } catch {
      backTargetRef.current = '/';
    }
  }, []);

  useEffect(() => {
    if (renderedCount >= files.length) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setRenderState((prev) => ({
            id,
            count: Math.min(
              (prev.id === id ? prev.count : INITIAL_THUMBNAILS) + LOAD_MORE_COUNT,
              files.length,
            ),
          }));
        }
      },
      { rootMargin: '200px' },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [renderedCount, files.length, id]);

  // Use full block from gallery-info when available, fall back to cached block from list
  const displayBlock: GalleryBlock | null =
    block ??
    (cachedBlock.type !== GalleryBlockType.LOADING && cachedBlock.type !== GalleryBlockType.FAILED
      ? cachedBlock
      : null);

  // Low-detail URL the hero shows first. Sourced from the module-level map
  // the list-card onClick wrote (the EXACT URL the user clicked), with a
  // cachedBlock fallback for direct-URL entry. Pinned via useMemo([id])
  // because the value lives outside the React tree — immune to remounts and
  // React Query revalidation.
  const cachedThumbnail = useMemo(() => {
    const remembered = getDetailEntryThumbnail(id);
    if (remembered) return remembered;
    if (
      cachedBlock.type === GalleryBlockType.LOADING ||
      cachedBlock.type === GalleryBlockType.FAILED
    ) {
      return null;
    }
    return cachedBlock.thumbnail ? resolveThumbnailUrl(cachedBlock.thumbnail) : null;
    // cachedBlock intentionally NOT in deps: we want the first-seen URL only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  // High-res hero variant: derived from the first file as soon as
  // useGalleryDetail resolves. Stable thereafter (files[0] is set once).
  const bigThumbnail = files.length > 0 ? getThumbnailUrl(files[0], 'big') : null;

  // The hero is two stacked layers (see render): the cached/clicked thumbnail
  // painted instantly underneath, and the big variant layered on top that only
  // becomes visible once it has fully decoded. No single-<img> src swap → no
  // one-frame blank → no flicker on list→detail.

  const stillLoadingFull = isLoading && !block;
  const detailFailed = !isLoading && error && !block;

  const relatedIds = displayBlock?.related?.slice(0, 12) ?? [];

  const { isFav, isPending: favPending, toggle: toggleFav } = useFavoriteToggle(id);
  const {
    progress: dlProgress,
    start: handleDownload,
    cancel: handleCancelDownload,
    error: dlError,
    isDownloaded,
    queuedPosition,
  } = useDownloadGallery(
    id,
    displayBlock?.title || `Gallery ${id}`,
    displayBlock?.thumbnail ?? ``,
    files,
    displayBlock?.tags as Record<string, string[]> | undefined,
  );

  // A completed gallery's button re-downloads on tap; confirm first so an
  // accidental tap doesn't re-start a finished download.
  const handleRedownload = useCallback(() => {
    if (window.confirm(t('detail.redownloadConfirm'))) handleDownload();
  }, [t, handleDownload]);

  // "Downloaded" but the on-disk image files are gone (user deleted them, or a
  // partial write) → surface it at the download button so the user can restore
  // with one tap instead of wondering why the reader falls back to network.
  const { filesMissing } = useDownloadedFilesPresent(id);

  const handleShare = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(String(id));
    } catch {
      // Fallback: prompt user to copy manually (execCommand is deprecated)
      window.prompt('Copy gallery ID:', String(id));
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [id]);

  const tagEntries = useMemo(() => {
    if (!displayBlock) return [];

    return (Object.entries(displayBlock.tags) as [TagType, string[]][])
      .sort(([a], [b]) => (TAG_ORDER[a] ?? 99) - (TAG_ORDER[b] ?? 99))
      .map(
        ([type, tags]) =>
          [type, prioritizeFavorites(tags, favoriteTags, (tag) => toFavoriteTagKey(type, tag))] as [
            TagType,
            string[],
          ],
      );
  }, [displayBlock, favoriteTags]);

  const tagI18n = useTagI18n(tagEntries);
  const localizedMediaType = useTagLocalName(TagType.TYPE, block?.mediaType);
  const localizedLanguage = useTagLocalName(TagType.LANGUAGE, block?.language);

  if (!displayBlock && isLoading)
    return (
      <div className="flex justify-center py-12">
        <Spinner size="md" />
      </div>
    );
  if (error && !displayBlock)
    return (
      <div className="py-12 text-center text-red-500">
        {t('detail.loadFailed')} #{id}
      </div>
    );
  if (!displayBlock)
    return (
      <div className="flex justify-center py-12">
        <Spinner size="md" />
      </div>
    );

  return (
    <div className="space-y-3 sm:space-y-6">
      {/* Mobile: sticky back bar (← + title), replaces the tab bar on this
          stacked route. Desktop: keep the inline back link (header stays). */}
      <BackBar title={displayBlock.title || `#${id}`} onBack={goBackToList} />
      <button
        onClick={goBackToList}
        className="-mx-2 hidden min-h-11 items-center gap-1 rounded-xl px-2 text-sm font-medium text-zinc-500 md:inline-flex md:hover:text-zinc-700 dark:text-zinc-400 dark:md:hover:text-zinc-200"
      >
        &larr; {t('detail.back')}
      </button>
      <div className="grid gap-3 md:grid-cols-[300px_1fr] md:gap-6">
        <Link
          href={readerHref(id)}
          className="group relative aspect-[3/4] w-full self-start overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-100 shadow-sm sm:rounded-lg sm:shadow-none dark:border-zinc-800 dark:bg-zinc-900"
        >
          {!cachedThumbnail && !bigThumbnail && (
            <div className="flex aspect-[3/4] items-center justify-center bg-zinc-100 text-zinc-400 dark:bg-zinc-800">
              {t('detail.noImage')}
            </div>
          )}
          {/* Two stacked layers for a flicker-free swap. Bottom: the exact
              clicked thumbnail, painted instantly from loadedSrcCache and never
              removed. Top: the big variant, which stays opacity:0 (AbortableImage's
              pre-load state) until it has fully decoded, then snaps in over the
              cached one. Because the bottom is always present there is no blank
              frame, and the top only appears once ready → no flicker. */}
          {cachedThumbnail && (
            <AbortableImage
              key={`hero-cached-${id}`}
              src={cachedThumbnail}
              alt={displayBlock.title}
              loading="eager"
              className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
            />
          )}
          {bigThumbnail && (
            <AbortableImage
              key={`hero-big-${id}`}
              src={bigThumbnail}
              alt={displayBlock.title}
              loading="eager"
              className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
            />
          )}
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggleFav();
            }}
            disabled={favPending}
            className={`absolute left-2 top-2 flex h-11 w-11 items-center justify-center rounded-full bg-black/50 backdrop-blur-sm transition-colors disabled:opacity-50 sm:h-auto sm:w-auto sm:p-1.5 ${isFav ? 'text-yellow-400' : 'text-white/70 sm:hover:text-white'}`}
            aria-label={isFav ? t('detail.removeFavorite') : t('detail.addFavorite')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill={isFav ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth={isFav ? 0 : 2}
              className="h-5 w-5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.562.562 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"
              />
            </svg>
          </button>
        </Link>
        <div className="min-w-0 space-y-3 sm:space-y-4">
          <div className="min-w-0">
            <button
              onClick={handleShare}
              className="mb-1 inline-flex min-h-10 items-center gap-1 rounded-xl text-base tabular-nums text-zinc-400 transition-colors active:text-zinc-600 sm:min-h-0 sm:text-sm sm:hover:text-zinc-600 dark:text-zinc-500 dark:active:text-zinc-300 sm:dark:hover:text-zinc-300"
            >
              #{id}
            </button>
            <h1 className="break-words text-2xl font-bold leading-tight text-zinc-900 dark:text-zinc-100 sm:text-3xl">
              {displayBlock.title || `Gallery #${id}`}
            </h1>
          </div>
          {block?.type === GalleryBlockType.DETAILED && (
            <p className="text-base leading-relaxed text-zinc-500 sm:text-sm dark:text-zinc-400">
              <Link
                href={`/search?q=${encodeURIComponent(`type:${block.mediaType}`)}`}
                className="active:text-zinc-700 sm:hover:text-zinc-700 sm:hover:underline dark:active:text-zinc-300 sm:dark:hover:text-zinc-300"
              >
                {localizedMediaType ?? block.mediaType}
              </Link>
              {' \u00b7 '}
              <Link
                href={`/search?q=${encodeURIComponent(`language:${block.language}`)}`}
                className="active:text-zinc-700 sm:hover:text-zinc-700 sm:hover:underline dark:active:text-zinc-300 sm:dark:hover:text-zinc-300"
              >
                {localizedLanguage ?? block.language}
              </Link>
              {' \u00b7 '}
              {displayBlock.date.toLocaleDateString()}
            </p>
          )}
          {tagEntries.length > 0 && (
            <div className="space-y-2">
              {tagEntries.map(([type, tags]) => (
                <div
                  key={type}
                  className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-2"
                >
                  <span className="shrink-0 text-sm font-semibold uppercase text-zinc-500 sm:w-20 sm:text-[13px] dark:text-zinc-400">
                    {type}
                  </span>
                  <div className="flex min-w-0 flex-wrap gap-1">
                    {tags.map((tag) => (
                      <TagFavoriteChip
                        key={tag}
                        tag={tag}
                        type={type}
                        displayName={tagI18n.get(`${type}:${tag}`)}
                        size="md"
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Link
              href={readerHref(id)}
              className="inline-flex min-h-[3.25rem] w-full items-center justify-center rounded-2xl bg-zinc-900 px-10 py-3 text-base font-semibold text-white active:bg-zinc-800 sm:min-h-12 sm:w-auto sm:rounded-lg sm:py-2.5 sm:text-sm sm:font-medium sm:hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:active:bg-zinc-200 sm:dark:hover:bg-zinc-200"
            >
              {t('detail.read')}
            </Link>
            {files.length > 0 &&
              (dlProgress ? (
                <button
                  onClick={handleCancelDownload}
                  className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-zinc-300 px-8 py-2.5 text-base font-semibold text-zinc-700 active:bg-zinc-100 sm:min-h-11 sm:w-auto sm:rounded-lg sm:text-sm sm:font-medium sm:hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:active:bg-zinc-800 sm:dark:hover:bg-zinc-800"
                >
                  <Spinner size="sm" />
                  {dlProgress.current}/{dlProgress.total}
                </button>
              ) : queuedPosition !== null ? (
                <button
                  onClick={handleCancelDownload}
                  className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-zinc-300 px-8 py-2.5 text-base font-semibold text-zinc-700 active:bg-zinc-100 sm:min-h-11 sm:w-auto sm:rounded-lg sm:text-sm sm:font-medium sm:hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:active:bg-zinc-800 sm:dark:hover:bg-zinc-800"
                >
                  {t('library.queue.queued')}
                  <span className="text-sm font-normal text-zinc-500 dark:text-zinc-400">
                    #{queuedPosition}
                  </span>
                </button>
              ) : filesMissing ? (
                <button
                  onClick={handleDownload}
                  title={t('detail.filesMissing')}
                  className="inline-flex min-h-12 w-full items-center justify-center gap-1.5 rounded-2xl border border-amber-600/40 bg-amber-50 px-8 py-2.5 text-base font-semibold text-amber-700 active:bg-amber-100 sm:min-h-11 sm:w-auto sm:rounded-lg sm:text-sm sm:font-medium sm:hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-400 dark:active:bg-amber-900/40 sm:dark:hover:bg-amber-900/40"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="h-4 w-4"
                  >
                    <path
                      fillRule="evenodd"
                      d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.515 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
                      clipRule="evenodd"
                    />
                  </svg>
                  {t('detail.filesMissing')}
                </button>
              ) : isDownloaded ? (
                <button
                  onClick={handleRedownload}
                  title={t('detail.redownload')}
                  className="inline-flex min-h-12 w-full items-center justify-center gap-1.5 rounded-2xl border border-green-600/40 bg-green-50 px-8 py-2.5 text-base font-semibold text-green-700 active:bg-green-100 sm:min-h-11 sm:w-auto sm:rounded-lg sm:text-sm sm:font-medium sm:hover:bg-green-100 dark:border-green-500/40 dark:bg-green-950/40 dark:text-green-400 dark:active:bg-green-900/40 sm:dark:hover:bg-green-900/40"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="h-4 w-4"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
                      clipRule="evenodd"
                    />
                  </svg>
                  {t('detail.downloaded')}
                </button>
              ) : (
                <button
                  onClick={handleDownload}
                  className="inline-flex min-h-12 w-full items-center justify-center gap-1.5 rounded-2xl border border-zinc-300 px-8 py-2.5 text-base font-semibold text-zinc-700 active:bg-zinc-100 sm:min-h-11 sm:w-auto sm:rounded-lg sm:text-sm sm:font-medium sm:hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:active:bg-zinc-800 sm:dark:hover:bg-zinc-800"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="h-4 w-4"
                  >
                    <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
                    <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
                  </svg>
                  {t('detail.download')}
                </button>
              ))}
          </div>
          {dlError && <p className="text-sm text-red-600 dark:text-red-400">{dlError}</p>}
        </div>
      </div>

      {detailFailed && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {t('detail.unavailable')}
        </div>
      )}

      {stillLoadingFull && files.length === 0 && !detailFailed && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            {t('detail.content')}
          </h2>
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <Spinner size="sm" />
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            {t('detail.content')} ({files.length})
          </h2>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 sm:gap-2 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10">
            {files.slice(0, renderedCount).map((file, idx) => (
              <Link
                key={idx}
                href={readerHref(id, idx + 1)}
                className="group relative overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-100 shadow-sm sm:rounded-lg sm:shadow-none dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="aspect-[3/4] overflow-hidden">
                  <AbortableImage
                    src={getThumbnailUrl(file)}
                    alt={`Page ${idx + 1}`}
                    className="h-full w-full object-cover transition-transform group-hover:scale-105"
                    loading="lazy"
                  />
                </div>
                {/* Page-number badge is always visible on touch devices
                    (no hover state) and fades in on hover on desktop. */}
                <span className="absolute right-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white opacity-100 backdrop-blur-sm transition-opacity md:opacity-0 md:group-hover:opacity-100">
                  {idx + 1}
                </span>
              </Link>
            ))}
            {renderedCount < files.length && (
              <div ref={sentinelRef} className="col-span-full flex justify-center py-4">
                <span className="text-sm text-zinc-400">
                  {renderedCount} / {files.length}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {relatedIds.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            {t('detail.related')}
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {relatedIds.map((rid) => (
              <GalleryCardById key={rid} id={rid} />
            ))}
          </div>
        </div>
      )}
      {copied && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900">
          {t('detail.copied')}
        </div>
      )}
    </div>
  );
}
