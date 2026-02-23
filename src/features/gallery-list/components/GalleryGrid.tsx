'use client';

import type { GalleryBlock } from '@/lib/utils/types';
import { GalleryCard, GalleryCardById } from './GalleryCard';

const GRID_CLASS = 'grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5';

function SkeletonGrid({ count = 25 }: { count?: number }) {
  return (
    <div className={GRID_CLASS}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          <div className="aspect-[3/4] animate-pulse bg-zinc-200 dark:bg-zinc-800" />
          <div className="space-y-2 p-2">
            <div className="h-4 w-3/4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Grid that renders pre-loaded blocks (used by search results). */
export function GalleryGrid({ blocks, isLoading }: { blocks: GalleryBlock[]; isLoading: boolean }) {
  if (isLoading && blocks.length === 0) {
    return <SkeletonGrid />;
  }
  return (
    <div className={GRID_CLASS}>
      {blocks.map((block) => (
        <GalleryCard key={block.id} block={block} />
      ))}
    </div>
  );
}

/** Grid that renders by IDs — each card fetches its own data progressively. */
export function GalleryGridById({ ids, isLoading }: { ids: number[]; isLoading: boolean }) {
  if (isLoading && ids.length === 0) {
    return <SkeletonGrid />;
  }
  return (
    <div className={GRID_CLASS}>
      {ids.map((id, idx) => (
        <div key={id} data-item-index={idx}>
          <GalleryCardById id={id} />
        </div>
      ))}
    </div>
  );
}
