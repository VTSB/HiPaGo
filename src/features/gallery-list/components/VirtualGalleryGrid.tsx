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
const MOBILE_GRID_COLUMN_GAP = 8;
const MOBILE_GRID_ROW_GAP = 10;
const DESKTOP_GRID_GAP = 12;

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

const COLS_BY_SETTINGS: Record<number, [number, number, number, number]> = {
  // [base(<640), sm(640+), md(768+), lg(1024+)]
  2: [2, 2, 2, 2],
  3: [2, 3, 3, 3],
  4: [2, 3, 4, 4],
  5: [2, 3, 4, 5],
  6: [2, 4, 5, 6],
  7: [2, 4, 6, 7],
};

function computeGridColumns(settingsCols: number, w: number): number {
  const bp = COLS_BY_SETTINGS[settingsCols || 5] ?? [2, 3, 4, 5];
  return w >= 1024 ? bp[3] : w >= 768 ? bp[2] : w >= 640 ? bp[1] : bp[0];
}

/**
 * Returns the actual column count for the current viewport + settings,
 * matching the breakpoints in GalleryGrid.tsx useGridClass.
 *
 * The initial value is computed synchronously from window.innerWidth so the
 * very first render already uses the real column count. A post-mount cols
 * correction used to trigger the colsChanged anchor effect below, which
 * called scrollToIndex(row 0) right after a back-navigation remount and
 * overwrote the browser's native scroll restoration (REQ__list-scroll-restoration).
 */
function useActualGridColumns(): number {
  const settingsCols = useSettingsStore((s) => s.gridColumns);
  const [cols, setCols] = useState(() =>
    typeof window === 'undefined' ? 5 : computeGridColumns(settingsCols, window.innerWidth),
  );

  useEffect(() => {
    const compute = () => {
      setCols(computeGridColumns(settingsCols, window.innerWidth));
    };
    compute();
    let rafId = 0;
    const onResize = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        compute();
      });
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [settingsCols]);

  return cols;
}

export const VirtualGalleryGrid = memo(
  forwardRef<VirtualGalleryGridHandle, Props>(function VirtualGalleryGrid(
    { totalLength, totalPages, viewingPage, getItemId, requestPage, onWindowSlide },
    ref,
  ) {
    const actualCols = useActualGridColumns();
    const containerRef = useRef<HTMLDivElement>(null);

    // Sliding window: always WINDOW_PAGES pages wide, slides as user scrolls
    const [windowStartPage, setWindowStartPage] = useState(() =>
      Math.max(1, viewingPage - Math.floor(WINDOW_PAGES / 2)),
    );
    // Ref always reflects latest windowStartPage (for use in effects without stale closures).
    // Assigned in an effect, not during render (react-hooks/refs).
    const windowStartPageRef = useRef(windowStartPage);
    useEffect(() => {
      windowStartPageRef.current = windowStartPage;
    });
    // Tracks previous value to detect when window actually moved
    const prevWindowStartPageRef = useRef(windowStartPage);

    // Ref always reflects the latest onWindowSlide prop so the slide effect can
    // call it without listing the (potentially unstable) prop in its deps array.
    // Assigned in a dependency-free effect, not during render (react-hooks/refs).
    const onWindowSlideRef = useRef(onWindowSlide);
    useEffect(() => {
      onWindowSlideRef.current = onWindowSlide;
    });

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
      let rafId = 0;
      const ro = new ResizeObserver(() => {
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          update();
        });
      });
      ro.observe(el);
      return () => {
        ro.disconnect();
        if (rafId) cancelAnimationFrame(rafId);
      };
    }, []);

    // Deterministic row height — computed directly from current state, no caching.
    // containerWidth is kept in sync by the ResizeObserver above; fall back to
    // window.innerWidth - 32 on the very first render before the observer fires.
    // Do NOT read containerRef.current here — ref access during render is disallowed
    // by react-hooks/refs; the state value is authoritative after first layout.
    const rowHeight = useMemo(() => {
      const width =
        containerWidth || (typeof window !== 'undefined' ? window.innerWidth - 16 : 400);
      const columnGap = width < 640 ? MOBILE_GRID_COLUMN_GAP : DESKTOP_GRID_GAP;
      const rowGap = width < 640 ? MOBILE_GRID_ROW_GAP : DESKTOP_GRID_GAP;
      const cardWidth = (width - columnGap * (actualCols - 1)) / actualCols;
      return Math.ceil(cardWidth * (3 / 2)) + rowGap;
    }, [actualCols, containerWidth]);

    const estimateSize = useCallback(() => rowHeight, [rowHeight]);

    const virtualizer = useWindowVirtualizer({
      count: totalRows,
      estimateSize,
      overscan: 8,
      scrollMargin,
    });

    // Slide window when viewingPage approaches an edge.
    // setWindowStartPage is deferred via setTimeout to avoid calling setState
    // synchronously in an effect body (react-hooks/set-state-in-effect).
    // onWindowSlide is read via ref (see onWindowSlideRef above) to avoid
    // re-running this effect when the parent re-renders with a new inline callback.
    const slidingRef = useRef(false);
    useEffect(() => {
      if (totalPages === 0 || slidingRef.current) return;
      const currentStart = windowStartPageRef.current;
      const currentEnd = Math.min(totalPages, currentStart + WINDOW_PAGES - 1);

      if (viewingPage < currentStart + NEAR_EDGE && currentStart > 1) {
        slidingRef.current = true;
        onWindowSlideRef.current?.();
        setTimeout(() => {
          setWindowStartPage((p) => Math.max(1, p - SLIDE_BY));
          slidingRef.current = false;
        }, 0);
      } else if (viewingPage > currentStart + WINDOW_PAGES - NEAR_EDGE && currentEnd < totalPages) {
        slidingRef.current = true;
        onWindowSlideRef.current?.();
        setTimeout(() => {
          setWindowStartPage((p) => Math.min(totalPages - WINDOW_PAGES + 1, p + SLIDE_BY));
          slidingRef.current = false;
        }, 0);
      }
    }, [viewingPage, totalPages]); // intentionally omits windowStartPage — read via ref; onWindowSlide — read via ref

    // Compensate scroll offset when window slides so the viewport stays on the same content.
    // Use scrollToIndex instead of scrollBy to avoid overshoot from inaccurate estimation.
    useLayoutEffect(() => {
      const prev = prevWindowStartPageRef.current;
      if (prev === windowStartPage) return;

      // Target the row that corresponds to viewingPage in the new window
      const anchorRow = Math.max(
        0,
        Math.floor(((viewingPage - windowStartPage) * PAGE_SIZE) / actualCols),
      );
      virtualizer.scrollToIndex(Math.min(anchorRow, totalRows - 1), { align: 'start' });

      prevWindowStartPageRef.current = windowStartPage;
    }, [windowStartPage, actualCols, viewingPage, totalRows, virtualizer]);

    // Invalidate virtualizer sizes and anchor scroll when container width or column count changes.
    const prevActualColsRef = useRef(actualCols);
    const prevContainerWidthRef = useRef(containerWidth);
    useLayoutEffect(() => {
      const colsChanged = prevActualColsRef.current !== actualCols;
      const widthChanged =
        prevContainerWidthRef.current !== containerWidth &&
        prevContainerWidthRef.current > 0 &&
        containerWidth > 0;
      if (!colsChanged && !widthChanged) return;
      prevActualColsRef.current = actualCols;
      prevContainerWidthRef.current = containerWidth;

      // Invalidate cached row sizes so virtualizer uses the new estimateSize
      virtualizer.measure();

      // Only anchor scroll when column count changes — that fundamentally rearranges
      // content. Width-only changes (e.g. dragging the window edge) just rescale rows
      // in place, so calling scrollToIndex on every pixel would force synchronous
      // layout (Virtualizer.getMaxScrollOffset → Layout) and tank resize FPS.
      if (colsChanged) {
        const anchorRow = Math.max(
          0,
          Math.floor(((viewingPage - windowStartPage) * PAGE_SIZE) / actualCols),
        );
        virtualizer.scrollToIndex(Math.min(anchorRow, totalRows - 1), { align: 'start' });
      }
    }, [actualCols, containerWidth, viewingPage, windowStartPage, totalRows, virtualizer]);

    useImperativeHandle(
      ref,
      () => ({
        scrollToPage: (page: number) => {
          const clampedPage = Math.max(1, Math.min(page, effectiveTotalPages));
          const newWindowStart = Math.max(
            1,
            Math.min(
              clampedPage - Math.floor(WINDOW_PAGES / 2),
              effectiveTotalPages - WINDOW_PAGES + 1,
            ),
          );

          // Skip compensation for explicit jumps — set prev = new before triggering layout effect
          prevWindowStartPageRef.current = newWindowStart;
          setWindowStartPage(newWindowStart);

          const targetRow = Math.floor(((clampedPage - newWindowStart) * PAGE_SIZE) / actualCols);
          setTimeout(() => {
            virtualizer.scrollToIndex(
              Math.min(targetRow, Math.ceil((WINDOW_PAGES * PAGE_SIZE) / actualCols) - 1),
              {
                align: 'start',
              },
            );
          }, 0);
        },
        scrollToItem: (itemIndex: number) => {
          const targetPage = Math.floor(itemIndex / PAGE_SIZE) + 1;
          const clampedPage = Math.max(1, Math.min(targetPage, effectiveTotalPages));
          const newWindowStart = Math.max(
            1,
            Math.min(
              clampedPage - Math.floor(WINDOW_PAGES / 2),
              effectiveTotalPages - WINDOW_PAGES + 1,
            ),
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

    // Main-list IDs are loaded lazily by page. On some mobile WebViews the
    // window virtualizer can lag behind native scroll updates, so relying only
    // on virtualItems means page 0 is seeded but later ID pages are never
    // requested. Request the current page window from viewingPage as an
    // independent signal; search-result grids already have all IDs, so their
    // requestPage is a no-op.
    useEffect(() => {
      const pageIndex = Math.max(0, viewingPage - 1);
      requestPage(pageIndex);
      requestPage(pageIndex + 1);
      requestPage(pageIndex + 2);
    }, [viewingPage, requestPage]);

    // Request pages for all rows currently in the virtual window
    useEffect(() => {
      for (const vRow of virtualItems) {
        const startItem = windowStartItem + vRow.index * actualCols;
        const endItem = Math.min(
          windowStartItem + (vRow.index + 1) * actualCols - 1,
          totalLength - 1,
        );
        requestPage(Math.floor(startItem / PAGE_SIZE));
        const endPage = Math.floor(endItem / PAGE_SIZE);
        if (endPage !== Math.floor(startItem / PAGE_SIZE)) requestPage(endPage);
      }
    }, [virtualItems, windowStartItem, actualCols, totalLength, requestPage]);

    return (
      <div ref={containerRef} className="-mx-2 sm:mx-0" style={{ overflowAnchor: 'none' }}>
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
                  paddingBottom:
                    rowHeight > 0 && (containerWidth || 0) < 640
                      ? `${MOBILE_GRID_ROW_GAP}px`
                      : `${DESKTOP_GRID_GAP}px`,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${actualCols}, minmax(0, 1fr))`,
                    columnGap:
                      (containerWidth || 0) < 640
                        ? `${MOBILE_GRID_COLUMN_GAP}px`
                        : `${DESKTOP_GRID_GAP}px`,
                    rowGap:
                      (containerWidth || 0) < 640
                        ? `${MOBILE_GRID_ROW_GAP}px`
                        : `${DESKTOP_GRID_GAP}px`,
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
  }),
);
