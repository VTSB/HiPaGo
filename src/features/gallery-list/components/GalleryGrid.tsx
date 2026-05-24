'use client';

import type { GalleryBlock } from '@/lib/utils/types';
import { GalleryCard, GalleryCardById } from './GalleryCard';
import { useSettingsStore } from '@/lib/store/settings';
import { PAGE_SIZE } from '@/lib/utils/constants';

const GRID_AUTO = 'grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5';

function useGridClass() {
  const cols = useSettingsStore((s) => s.gridColumns);
  if (!cols || cols === 0) return GRID_AUTO;
  const colMap: Record<number, string> = {
    2: 'grid grid-cols-2 gap-4 sm:gap-3',
    3: 'grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-3',
    4: 'grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-3 md:grid-cols-4',
    5: 'grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5',
    6: 'grid grid-cols-2 gap-4 sm:grid-cols-4 sm:gap-3 md:grid-cols-5 lg:grid-cols-6',
    7: 'grid grid-cols-2 gap-4 sm:grid-cols-4 sm:gap-3 md:grid-cols-6 lg:grid-cols-7',
  };
  return colMap[cols] ?? GRID_AUTO;
}

function SkeletonCard() {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="aspect-[3/4] animate-pulse bg-zinc-200 dark:bg-zinc-800" />
      <div className="space-y-2 p-2">
        <div className="h-4 w-3/4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
    </div>
  );
}

export function SkeletonGrid({ count = 25 }: { count?: number }) {
  const gridClass = useGridClass();
  return (
    <div className={gridClass}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

/** Grid that renders pre-loaded blocks (used by search results). */
export function GalleryGrid({ blocks, isLoading }: { blocks: GalleryBlock[]; isLoading: boolean }) {
  const gridClass = useGridClass();
  if (isLoading && blocks.length === 0) {
    return <SkeletonGrid />;
  }
  return (
    <div className={gridClass}>
      {blocks.map((block) => (
        <GalleryCard key={block.id} block={block} />
      ))}
    </div>
  );
}

/** Grid that renders by IDs — each card fetches its own data progressively. */
export function GalleryGridById({
  ids,
  isLoading,
  indexOffset = 0,
  isFetchingNextPage = false,
}: {
  ids: number[];
  isLoading: boolean;
  indexOffset?: number;
  isFetchingNextPage?: boolean;
}) {
  const gridClass = useGridClass();
  if (isLoading && ids.length === 0) {
    return <SkeletonGrid />;
  }
  return (
    <div className={gridClass}>
      {ids.map((id, idx) => (
        <div key={id} data-item-index={idx + indexOffset}>
          <GalleryCardById id={id} />
        </div>
      ))}
      {isFetchingNextPage && Array.from({ length: PAGE_SIZE }, (_, i) => (
        <SkeletonCard key={`skeleton-next-${i}`} />
      ))}
    </div>
  );
}
