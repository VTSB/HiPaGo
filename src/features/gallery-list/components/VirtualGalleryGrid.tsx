'use client';

import {
  forwardRef,
  memo,
  useImperativeHandle,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { GalleryCardById } from './GalleryCard';
import { useSettingsStore } from '@/lib/store/settings';
import { PAGE_SIZE } from '@/lib/utils/constants';
import { useImagePreloader } from '../hooks/useImagePreloader';

/** Total pages in the scroll window at any time */
const WINDOW_PAGES = 200;
/** Pages from edge that triggers a window slide */
const NEAR_EDGE = 30;
/** Pages to slide per step */
const SLIDE_BY = 100;

export interface VirtualGalleryGridHandle {
  scrollToPage: (page: number) => void;
  scrollToItem: (itemIndex: number) => void;
}

interface Props {
  totalLength: number;
  totalPages: number;
  viewingPage: number;
  getItemId: (itemIndex: number) => number | null;
  requestPage: (pageIndex: number) => void;
  /** Called just before a window slide so FloatingPageNav can suppress tracking. */
  onWindowSlide?: () => void;
}

function SkeletonCard() {
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

/**
 * Returns the actual column count for the current viewport + settings,
 * matching the breakpoints in GalleryGrid.tsx useGridClass.
 */
function useActualGridColumns(): number {
  const settingsCols = useSettingsStore((s) => s.gridColumns);
  const [cols, setCols] = useState(5);

  useEffect(() => {
    const colsBySettings: Record<number, [number, number, number, number]> = {
      // [base(<640), sm(640+), md(768+), lg(1024+)]
      2: [2, 2, 2, 2],
      3: [2, 3, 3, 3],
      4: [2, 3, 4, 4],
      5: [2, 3, 4, 5],
      6: [3, 4, 5, 6],
      7: [3, 4, 6, 7],
    };
    const compute = () => {
      const w = window.innerWidth;
      const effective = settingsCols || 5;
      const bp = colsBySettings[effective] ?? [2, 3, 4, 5];
      setCols(w >= 1024 ? bp[3] : w >= 768 ? bp[2] : w >= 640 ? bp[1] : bp[0]);
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [settingsCols]);

  return cols;
}

export const VirtualGalleryGrid = memo(forwardRef<VirtualGalleryGridHandle, Props>(
  function VirtualGalleryGrid({ totalLength, totalPages, viewingPage, getItemId, requestPage, onWindowSlide }, ref) {
    const actualCols = useActualGridColumns();
    const containerRef = useRef<HTMLDivElement>(null);

    // Sliding window: always WINDOW_PAGES pages wide, slides as user scrolls
    const [windowStartPage, setWindowStartPage] = useState(() =>
      Math.max(1, viewingPage - Math.floor(WINDOW_PAGES / 2))
    );
    // Ref always reflects latest windowStartPage (for use in effects without stale closures)
    const windowStartPageRef = useRef(windowStartPage);
    windowStartPageRef.current = windowStartPage;
    // Tracks previous value to detect when window actually moved
    const prevWindowStartPageRef = useRef(windowStartPage);

    // Derived window bounds
    const effectiveTotalPages = totalPages || WINDOW_PAGES;
    const windowEndPage = Math.min(effectiveTotalPages, windowStartPage + WINDOW_PAGES - 1);
    const windowStartItem = (windowStartPage - 1) * PAGE_SIZE;
    const windowItemCount = Math.max(
      0,
      Math.min((windowEndPage - windowStartPage + 1) * PAGE_SIZE, totalLength - windowStartItem),
    );
    const totalRows = windowItemCount > 0 ? Math.ceil(windowItemCount / actualCols) : 0;

    // scrollMargin = distance from window top to container top
    const [scrollMargin, setScrollMargin] = useState(0);
    // Track container width for virtualizer size invalidation on resize
    const [containerWidth, setContainerWidth] = useState(0);
    useLayoutEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const update = () => {
        setScrollMargin(el.offsetTop ?? 0);
        setContainerWidth(Math.round(el.clientWidth));
      };
      update();
      const ro = new ResizeObserver(() => update());
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    // Deterministic row height — computed directly from current state, no caching
    const rowHeight = useMemo(() => {
      const width = containerWidth || containerRef.current?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth - 32 : 400);
      const gap = 12;
      const cardWidth = (width - gap * (actualCols - 1)) / actualCols;
      return Math.ceil(cardWidth * (3 / 2)) + gap;
    }, [actualCols, containerWidth]);

    const estimateSize = useCallback(() => rowHeight, [rowHeight]);

    const virtualizer = useWindowVirtualizer({
      count: totalRows,
      estimateSize,
      overscan: 4,
      scrollMargin,
    });

    // Slide window when viewingPage approaches an edge
    const slidingRef = useRef(false);
    useEffect(() => {
      if (totalPages === 0 || slidingRef.current) return;
      const currentStart = windowStartPageRef.current;
      const currentEnd = Math.min(totalPages, currentStart + WINDOW_PAGES - 1);

      if (viewingPage < currentStart + NEAR_EDGE && currentStart > 1) {
        slidingRef.current = true;
        onWindowSlide?.();
        setWindowStartPage((p) => Math.max(1, p - SLIDE_BY));
        setTimeout(() => { slidingRef.current = false; }, 200);
      } else if (viewingPage > currentStart + WINDOW_PAGES - NEAR_EDGE && currentEnd < totalPages) {
        slidingRef.current = true;
        onWindowSlide?.();
        setWindowStartPage((p) => Math.min(totalPages - WINDOW_PAGES + 1, p + SLIDE_BY));
        setTimeout(() => { slidingRef.current = false; }, 200);
      }
    }, [viewingPage, totalPages]); // intentionally omits windowStartPage — read via ref

    // Compensate scroll offset when window slides so the viewport stays on the same content.
    // Use scrollToIndex instead of scrollBy to avoid overshoot from inaccurate estimation.
    useLayoutEffect(() => {
      const prev = prevWindowStartPageRef.current;
      if (prev === windowStartPage) return;

      // Target the row that corresponds to viewingPage in the new window
      const anchorRow = Math.max(
        0,
        Math.floor((viewingPage - windowStartPage) * PAGE_SIZE / actualCols),
      );
      virtualizer.scrollToIndex(Math.min(anchorRow, totalRows - 1), { align: 'start' });

      prevWindowStartPageRef.current = windowStartPage;
    }, [windowStartPage, actualCols, viewingPage, totalRows, virtualizer]);

    // Invalidate virtualizer sizes and anchor scroll when container width or column count changes.
    const prevActualColsRef = useRef(actualCols);
    const prevContainerWidthRef = useRef(containerWidth);
    useLayoutEffect(() => {
      const colsChanged = prevActualColsRef.current !== actualCols;
      const widthChanged = prevContainerWidthRef.current !== containerWidth && prevContainerWidthRef.current > 0 && containerWidth > 0;
      if (!colsChanged && !widthChanged) return;
      prevActualColsRef.current = actualCols;
      prevContainerWidthRef.current = containerWidth;

      // Invalidate all cached row sizes so virtualizer uses the new estimateSize
      virtualizer.measure();

      // Anchor scroll to the same content position
      const anchorRow = Math.max(
        0,
        Math.floor((viewingPage - windowStartPage) * PAGE_SIZE / actualCols),
      );
      virtualizer.scrollToIndex(Math.min(anchorRow, totalRows - 1), { align: 'start' });
    }, [actualCols, containerWidth, viewingPage, windowStartPage, totalRows, virtualizer]);

    // On first render with data, scroll to the initial viewingPage if it's not page 1.
    // This handles scroll restoration after navigating back from detail.
    const initialScrollDoneRef = useRef(false);
    useLayoutEffect(() => {
      if (initialScrollDoneRef.current || totalRows === 0 || viewingPage <= 1) return;
      initialScrollDoneRef.current = true;

      const targetRow = Math.max(
        0,
        Math.floor((viewingPage - windowStartPage) * PAGE_SIZE / actualCols),
      );
      virtualizer.scrollToIndex(Math.min(targetRow, totalRows - 1), { align: 'start' });
    }, [totalRows, viewingPage, windowStartPage, actualCols, virtualizer]);

    useImperativeHandle(
      ref,
      () => ({
        scrollToPage: (page: number) => {
          const clampedPage = Math.max(1, Math.min(page, effectiveTotalPages));
          const newWindowStart = Math.max(
            1,
            Math.min(clampedPage - Math.floor(WINDOW_PAGES / 2), effectiveTotalPages - WINDOW_PAGES + 1),
          );

          // Skip compensation for explicit jumps — set prev = new before triggering layout effect
          prevWindowStartPageRef.current = newWindowStart;
          setWindowStartPage(newWindowStart);

          const targetRow = Math.floor(((clampedPage - newWindowStart) * PAGE_SIZE) / actualCols);
          setTimeout(() => {
            virtualizer.scrollToIndex(Math.min(targetRow, Math.ceil((WINDOW_PAGES * PAGE_SIZE) / actualCols) - 1), {
              align: 'start',
            });
          }, 0);
        },
        scrollToItem: (itemIndex: number) => {
          const targetPage = Math.floor(itemIndex / PAGE_SIZE) + 1;
          const clampedPage = Math.max(1, Math.min(targetPage, effectiveTotalPages));
          const newWindowStart = Math.max(
            1,
            Math.min(clampedPage - Math.floor(WINDOW_PAGES / 2), effectiveTotalPages - WINDOW_PAGES + 1),
          );
          prevWindowStartPageRef.current = newWindowStart;
          setWindowStartPage(newWindowStart);
          const newWindowStartItem = (newWindowStart - 1) * PAGE_SIZE;
          const targetRow = Math.floor((itemIndex - newWindowStartItem) / actualCols);
          setTimeout(() => {
            virtualizer.scrollToIndex(
              Math.min(targetRow, Math.ceil((WINDOW_PAGES * PAGE_SIZE) / actualCols) - 1),
              { align: 'start' },
            );
          }, 0);
        },
      }),
      [actualCols, effectiveTotalPages, virtualizer],
    );

    const virtualItems = virtualizer.getVirtualItems();

    useImagePreloader({
      getItemId,
      virtualItems,
      windowStartItem,
      actualCols,
      totalLength,
      requestPage,
    });

    // Request pages for all rows currently in the virtual window
    useEffect(() => {
      for (const vRow of virtualItems) {
        const startItem = windowStartItem + vRow.index * actualCols;
        const endItem = Math.min(windowStartItem + (vRow.index + 1) * actualCols - 1, totalLength - 1);
        requestPage(Math.floor(startItem / PAGE_SIZE));
        const endPage = Math.floor(endItem / PAGE_SIZE);
        if (endPage !== Math.floor(startItem / PAGE_SIZE)) requestPage(endPage);
      }
    }, [virtualItems, windowStartItem, actualCols, totalLength, requestPage]);

    return (
      <div ref={containerRef} style={{ overflowAnchor: 'none' }}>
        <div
          style={{
            height: `${totalRows * rowHeight}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualItems.map((vRow) => {
            const rowStart = windowStartItem + vRow.index * actualCols;
            return (
              <div
                key={vRow.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${rowHeight}px`,
                  transform: `translateY(${vRow.index * rowHeight}px)`,
                  paddingBottom: '12px',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${actualCols}, minmax(0, 1fr))`,
                    gap: '12px',
                  }}
                >
                  {Array.from({ length: actualCols }, (_, col) => {
                    const itemIndex = rowStart + col;
                    if (itemIndex >= totalLength) return <div key={col} />;
                    const id = getItemId(itemIndex);
                    return (
                      <div key={itemIndex} data-item-index={itemIndex}>
                        {id !== null ? <GalleryCardById id={id} /> : <SkeletonCard />}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  },
));
