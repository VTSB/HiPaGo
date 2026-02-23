'use client';

import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import type { GalleryBlock } from '@/lib/utils/types';
import { GalleryBlockType, type TagType } from '@/lib/utils/types';
import { TagChip } from '@/shared/components/TagChip';
import { AbortableImage } from '@/shared/components/AbortableImage';
import { useGalleryBlock } from '../hooks/useGalleryBlock';
import { useT } from '@/lib/i18n/useT';
import { useTagI18n } from '@/lib/i18n/useTagI18n';
import { useSettingsStore } from '@/lib/store/settings';
import { fetchGalleryInfo } from '@/lib/api/gallery';

/** Check if a gallery block matches any blur tags. */
function shouldBlur(block: GalleryBlock, blurTags: string[]): boolean {
  if (blurTags.length === 0) return false;
  if (block.type === GalleryBlockType.LOADING || block.type === GalleryBlockType.FAILED) return false;
  for (const [type, tags] of Object.entries(block.tags)) {
    for (const tag of tags || []) {
      const key = `${type}:${tag.replace(/ /g, '_')}`;
      if (blurTags.includes(key)) return true;
      // Handle legacy cached blocks where ♂/♀ tags are stored under generic 'tag' type
      if (type === 'tag') {
        if (tag.endsWith(' ♂')) {
          const legacyKey = `male:${tag.slice(0, -2).replace(/ /g, '_')}`;
          if (blurTags.includes(legacyKey)) return true;
        } else if (tag.endsWith(' ♀')) {
          const legacyKey = `female:${tag.slice(0, -2).replace(/ /g, '_')}`;
          if (blurTags.includes(legacyKey)) return true;
        }
      }
    }
  }
  return false;
}

function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="aspect-[3/4] animate-pulse bg-zinc-200 dark:bg-zinc-800" />
      <div className="space-y-2 p-2">
        <div className="h-4 w-3/4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
    </div>
  );
}

function CardContent({ block, onPrefetch }: { block: GalleryBlock; onPrefetch?: () => void }) {
  const t = useT();
  const blurTags = useSettingsStore((s) => s.blurTags);
  const blurred = useMemo(() => shouldBlur(block, blurTags), [block, blurTags]);
  const tagEntries = block.type === GalleryBlockType.DETAILED || block.type === GalleryBlockType.NOT_DETAILED
    ? (Object.entries(block.tags) as [TagType, string[]][])
    : [];
  const tagI18n = useTagI18n(tagEntries);

  if (block.type === GalleryBlockType.LOADING) {
    return <CardSkeleton />;
  }
  if (block.type === GalleryBlockType.FAILED) {
    return (
      <div className="flex aspect-[3/4] items-center justify-center rounded-lg border border-red-200 bg-red-50 text-sm text-red-500 dark:border-red-900 dark:bg-red-950">
        {t('card.failed')} #{block.id}
      </div>
    );
  }
  const displayTags: { tag: string; type: TagType }[] = [];
  for (const [type, tags] of Object.entries(block.tags)) {
    for (const tag of tags || []) {
      if (displayTags.length >= 5) break;
      displayTags.push({ tag, type: type as TagType });
    }
  }

  return (
    <Link href={`/gallery/${block.id}`} className="group block" style={{ contentVisibility: 'auto', containIntrinsicSize: '0 400px' }} onPointerEnter={onPrefetch}>
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900">
        <div className={`relative aspect-[3/4] overflow-hidden bg-zinc-100 dark:bg-zinc-800${blurred ? ' blur-lg' : ''}`}>
          {block.thumbnail ? (
            <AbortableImage src={block.thumbnail} alt={block.title} className="h-full w-full object-cover transition-transform group-hover:scale-105" loading="lazy" />
          ) : (
            <div className="flex h-full items-center justify-center text-zinc-400">{t('detail.noImage')}</div>
          )}
        </div>
        <div className="p-2">
          <h3 className="line-clamp-2 text-sm font-medium leading-tight text-zinc-900 dark:text-zinc-100">{block.title || `#${block.id}`}</h3>
          {displayTags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {displayTags.map(({ tag, type }) => (
                <TagChip key={`${type}-${tag}`} tag={tag} type={type} displayName={tagI18n.get(`${type}:${tag}`)} linked={false} size="sm" />
              ))}
            </div>
          )}
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
export function GalleryCard({ block }: { block: GalleryBlock }) {
  const prefetch = usePrefetchGalleryInfo(block.id);
  return <CardContent block={block} onPrefetch={prefetch} />;
}

/** Render a gallery card by ID — fetches its own data progressively. */
export function GalleryCardById({ id }: { id: number }) {
  const block = useGalleryBlock(id);
  const prefetch = usePrefetchGalleryInfo(id);
  return <CardContent block={block} onPrefetch={prefetch} />;
}
