'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useGalleryDetail } from '@/features/gallery-detail/hooks/useGalleryDetail';
import { GalleryBlockType, TagType } from '@/lib/utils/types';
import { TagChip } from '@/shared/components/TagChip';
import { GalleryCardById } from '@/features/gallery-list/components/GalleryCard';
import { getThumbnailUrl } from '@/lib/utils/image-url';
import { AbortableImage } from '@/shared/components/AbortableImage';
import { resolveThumbnailUrl } from '@/lib/api/url-resolver';
import { useState, useEffect, useCallback, useRef } from 'react';
import { recordVisit } from '@/lib/db/gallery';
import { Spinner } from '@/shared/components/Spinner';
import { useT } from '@/lib/i18n/useT';
import { useTagI18n, useTagLocalName } from '@/lib/i18n/useTagI18n';
import { useGalleryBlock } from '@/features/gallery-list/hooks/useGalleryBlock';
import { getGgConfig } from '@/lib/api/client';
import type { GalleryBlock } from '@/lib/utils/types';
import { useFavoriteToggle } from '@/features/gallery-detail/hooks/useFavoriteToggle';
import { useDownloadGallery } from '@/features/gallery-detail/hooks/useDownloadGallery';

const INITIAL_THUMBNAILS = 20;
const LOAD_MORE_COUNT = 20;

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
  const renderedCount = renderState.id === id ? renderState.count : INITIAL_THUMBNAILS;

  useEffect(() => {
    recordVisit(id).catch((e) => console.warn('[detail] Visit record failed:', e));
    // Warm gg.js cache so reader opens instantly
    getGgConfig().catch((e) => console.warn('[detail] GgConfig warm failed:', e));
  }, [id]);

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
  const stillLoadingFull = isLoading && !block;
  const detailFailed = !isLoading && error && !block;

  const relatedIds = displayBlock?.related?.slice(0, 12) ?? [];

  const { isFav, isPending: favPending, toggle: toggleFav } = useFavoriteToggle(id);
  const {
    progress: dlProgress,
    start: handleDownload,
    cancel: handleCancelDownload,
  } = useDownloadGallery(
    id,
    displayBlock?.title || `Gallery ${id}`,
    displayBlock?.thumbnail ?? ``,
    files,
    displayBlock?.tags as Record<string, string[]> | undefined,
  );

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

  const tagEntries = displayBlock
    ? (Object.entries(displayBlock.tags) as [TagType, string[]][]).sort(
        ([a], [b]) => (TAG_ORDER[a] ?? 99) - (TAG_ORDER[b] ?? 99),
      )
    : [];

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

  const bigThumbnail = files.length > 0 ? getThumbnailUrl(files[0], 'big') : null;

  return (
    <div className="space-y-6">
      <button
        onClick={() => router.back()}
        className="-mx-2 inline-flex min-h-11 items-center gap-1 px-2 text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
      >
        &larr; {t('detail.back')}
      </button>
      <div className="grid gap-6 md:grid-cols-[300px_1fr]">
        <Link
          href={`/gallery/${id}/reader`}
          className="group relative self-start overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800"
        >
          {bigThumbnail ? (
            <AbortableImage
              src={bigThumbnail}
              alt={displayBlock.title}
              className="w-full object-cover transition-transform group-hover:scale-[1.02]"
            />
          ) : displayBlock.thumbnail ? (
            <AbortableImage
              src={resolveThumbnailUrl(displayBlock.thumbnail)}
              alt={displayBlock.title}
              className="w-full object-cover transition-transform group-hover:scale-[1.02]"
            />
          ) : (
            <div className="flex aspect-[3/4] items-center justify-center bg-zinc-100 text-zinc-400 dark:bg-zinc-800">
              {t('detail.noImage')}
            </div>
          )}
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggleFav();
            }}
            disabled={favPending}
            className={`absolute left-2 top-2 rounded-full bg-black/50 p-1.5 backdrop-blur-sm transition-colors disabled:opacity-50 ${isFav ? 'text-yellow-400' : 'text-white/70 hover:text-white'}`}
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
        <div className="min-w-0 space-y-4">
          <div className="min-w-0">
            <button
              onClick={handleShare}
              className="mb-1 inline-flex items-center gap-1 text-sm tabular-nums text-zinc-400 transition-colors hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
            >
              #{id}
            </button>
            <h1 className="break-words text-3xl font-bold text-zinc-900 dark:text-zinc-100">
              {displayBlock.title || `Gallery #${id}`}
            </h1>
          </div>
          {block?.type === GalleryBlockType.DETAILED && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              <Link
                href={`/search?q=${encodeURIComponent(`type:${block.mediaType}`)}`}
                className="hover:text-zinc-700 hover:underline dark:hover:text-zinc-300"
              >
                {localizedMediaType ?? block.mediaType}
              </Link>
              {' \u00b7 '}
              <Link
                href={`/search?q=${encodeURIComponent(`language:${block.language}`)}`}
                className="hover:text-zinc-700 hover:underline dark:hover:text-zinc-300"
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
                <div key={type} className="flex items-baseline gap-2">
                  <span className="w-20 shrink-0 text-[13px] font-semibold uppercase text-zinc-500 dark:text-zinc-400">
                    {type}
                  </span>
                  <div className="flex min-w-0 flex-wrap gap-1">
                    {tags.map((tag) => (
                      <TagChip
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
              href={`/gallery/${id}/reader`}
              className="inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-zinc-900 px-10 py-3 text-base font-medium text-white hover:bg-zinc-800 sm:w-auto sm:py-2.5 sm:text-sm dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {t('detail.read')}
            </Link>
            {files.length > 0 &&
              (dlProgress ? (
                <button
                  onClick={handleCancelDownload}
                  className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-zinc-300 px-8 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 sm:w-auto dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <Spinner size="sm" />
                  {dlProgress.current}/{dlProgress.total}
                </button>
              ) : (
                <button
                  onClick={handleDownload}
                  className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-300 px-8 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 sm:w-auto dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
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
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10">
            {files.slice(0, renderedCount).map((file, idx) => (
              <Link
                key={idx}
                href={`/gallery/${id}/reader?page=${idx + 1}`}
                className="group relative overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
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
