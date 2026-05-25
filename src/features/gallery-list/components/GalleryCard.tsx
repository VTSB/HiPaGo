'use client';

import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { memo, useCallback, useMemo } from 'react';
import type { GalleryBlock } from '@/lib/utils/types';
import { GalleryBlockType, type TagType } from '@/lib/utils/types';
import { tagFromGalleryEntry, toSearchString } from '@/lib/utils/hitomi-tag';
import { TagChip } from '@/shared/components/TagChip';
import { AbortableImage } from '@/shared/components/AbortableImage';
import { resolveThumbnailUrl } from '@/lib/api/url-resolver';
import { useGalleryBlock } from '../hooks/useGalleryBlock';
import { useT } from '@/lib/i18n/useT';
import { useTagI18n } from '@/lib/i18n/useTagI18n';
import { useSettingsStore } from '@/lib/store/settings';
import { fetchGalleryInfo } from '@/lib/api/gallery';
import { galleryHref } from '@/lib/utils/routes';
import { captureListScrollSnapshot } from '../utils/listScrollSnapshot';

const LAST_LIST_URL_KEY = 'hipago:last-list-url';

/** Check if a gallery block matches any blur tags. */
function shouldBlur(block: GalleryBlock, blurTags: string[]): boolean {
  if (blurTags.length === 0) return false;
  if (block.type === GalleryBlockType.LOADING || block.type === GalleryBlockType.FAILED)
    return false;
  for (const [type, tags] of Object.entries(block.tags)) {
    for (const tag of tags || []) {
      const key = toSearchString(tagFromGalleryEntry(type as TagType, tag));
      if (blurTags.includes(key)) return true;
      // Handle legacy cached blocks where ♂/♀ tags are stored under generic 'tag' type
      if (type === 'tag') {
        if (tag.endsWith(' ♂')) {
          const legacyKey = toSearchString(
            tagFromGalleryEntry('male' as TagType, tag.slice(0, -2)),
          );
          if (blurTags.includes(legacyKey)) return true;
        } else if (tag.endsWith(' ♀')) {
          const legacyKey = toSearchString(
            tagFromGalleryEntry('female' as TagType, tag.slice(0, -2)),
          );
          if (blurTags.includes(legacyKey)) return true;
        }
      }
    }
  }
  return false;
}

function CardSkeleton() {
  return (
    <div className="relative aspect-[2/3] overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-200 dark:bg-zinc-800 animate-pulse">
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-2 pt-8 pb-2">
        <div className="h-4 w-3/4 rounded bg-zinc-400/50 dark:bg-zinc-600/50" />
        <div className="mt-1.5 flex gap-1">
          <div className="h-5 w-12 rounded-full bg-zinc-400/50 dark:bg-zinc-600/50" />
          <div className="h-5 w-10 rounded-full bg-zinc-400/50 dark:bg-zinc-600/50" />
          <div className="h-5 w-14 rounded-full bg-zinc-400/50 dark:bg-zinc-600/50" />
        </div>
      </div>
    </div>
  );
}

function CardContent({ block, onPrefetch }: { block: GalleryBlock; onPrefetch?: () => void }) {
  const queryClient = useQueryClient();
  const t = useT();
  const blurTags = useSettingsStore((s) => s.blurTags);
  const blurred = useMemo(() => shouldBlur(block, blurTags), [block, blurTags]);
  const tagEntries = useMemo(
    () =>
      block.type === GalleryBlockType.DETAILED || block.type === GalleryBlockType.NOT_DETAILED
        ? (Object.entries(block.tags) as [TagType, string[]][])
        : [],
    [block.type, block.tags],
  );
  const tagI18n = useTagI18n(tagEntries);
  const displayTags = useMemo(() => {
    if (block.type === GalleryBlockType.LOADING || block.type === GalleryBlockType.FAILED)
      return [];
    const all: { tag: string; type: TagType; priority: number }[] = [];
    for (const [type, tags] of Object.entries(block.tags)) {
      for (const tag of tags || []) {
        let priority: number;
        if (tag === 'uncensored') priority = 0;
        else if (type === 'artist' || type === 'group') priority = 1;
        else priority = 2;
        all.push({ tag, type: type as TagType, priority });
      }
    }
    all.sort((a, b) => a.priority - b.priority);
    return all;
  }, [block.tags, block.type]);

  if (block.type === GalleryBlockType.LOADING) {
    return <CardSkeleton />;
  }
  if (block.type === GalleryBlockType.FAILED) {
    return (
      <div className="flex aspect-[2/3] items-center justify-center rounded-lg border border-red-200 bg-red-50 text-sm text-red-500 dark:border-red-900 dark:bg-red-950">
        {t('card.failed')} #{block.id}
      </div>
    );
  }

  return (
    <Link
      href={galleryHref(block.id)}
      className="group block touch-manipulation"
      onClick={(event) => {
        try {
          const url = window.location.pathname + window.location.search;
          captureListScrollSnapshot(event.currentTarget, block.id);
          sessionStorage.setItem(LAST_LIST_URL_KEY, url);
        } catch {
          // History/session storage can be unavailable in private/embedded contexts.
        }
      }}
      onPointerEnter={onPrefetch}
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-100 shadow-sm transition-transform active:scale-[0.985] sm:rounded-lg sm:shadow-none dark:border-zinc-800 dark:bg-zinc-800 sm:hover:shadow-lg">
        {block.thumbnail ? (
          <AbortableImage
            src={resolveThumbnailUrl(block.thumbnail)}
            alt={block.title}
            className={`h-full w-full object-cover transition-transform${blurred ? ' blur-xl scale-[1.15]' : ' group-hover:scale-105'}`}
            loading="lazy"
            onPermanentError={() => {
              // Thumbnail URL is stale/dead — invalidate the block cache so it re-fetches with fresh URL
              queryClient.invalidateQueries({ queryKey: ['gallery-block', block.id] });
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-zinc-400">
            {t('detail.noImage')}
          </div>
        )}
        <div
          className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t ${blurred ? 'from-black/60 via-black/30' : 'from-black/95 via-black/70'} to-transparent pt-10`}
        >
          <div className="px-3 pt-2 pb-3 backdrop-blur-sm sm:px-2 sm:pt-1.5 sm:pb-2">
            <h3 className="line-clamp-2 text-base font-semibold leading-snug text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.8)] sm:text-sm sm:leading-tight">
              {block.title || `#${block.id}`}
            </h3>
            {displayTags.length > 0 && (
              // Mobile (<md): cap chips to 1 visible row to reclaim ~22px per
              // card. Desktop (≥md): keep the original 2-row affordance since
              // cards are larger and the metadata helps scanability there.
              <div className="mt-1 flex flex-wrap gap-1 overflow-hidden max-h-[22px] md:max-h-[44px]">
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
  );
}

/** Prefetch gallery detail info on hover so the detail page loads faster. */
function usePrefetchGalleryInfo(id: number) {
  const queryClient = useQueryClient();
  return useCallback(() => {
    queryClient.prefetchQuery({
      queryKey: ['gallery-info', id],
      queryFn: () => fetchGalleryInfo(id),
      staleTime: 5 * 60 * 1000,
    });
  }, [queryClient, id]);
}

/** Render a gallery card by passing a pre-loaded block. */
export const GalleryCard = memo(function GalleryCard({ block }: { block: GalleryBlock }) {
  const prefetch = usePrefetchGalleryInfo(block.id);
  return <CardContent block={block} onPrefetch={prefetch} />;
});

/** Render a gallery card by ID — fetches its own data progressively. */
export const GalleryCardById = memo(function GalleryCardById({ id }: { id: number }) {
  const block = useGalleryBlock(id);
  const prefetch = usePrefetchGalleryInfo(id);
  return <CardContent block={block} onPrefetch={prefetch} />;
});
