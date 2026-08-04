'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefCallback,
  type SyntheticEvent,
} from 'react';
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import type { GalleryImage } from '@/lib/utils/types';
import { AbortableImage } from '@/shared/components/AbortableImage';
import { useSettingsStore } from '@/lib/store/settings';
import { OfflineImage } from './OfflineImage';
import { ReaderLoadState } from './ReaderLoadState';
import { useReaderImageSources } from '@/features/reader/hooks/useReaderImageSources';
import type { OfflineImageSource } from '@/features/reader/hooks/useOfflineImages';
import { useT } from '@/lib/i18n/useT';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
const ROW_OVERSCAN = 2;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

interface ViewportMetrics {
  width: number;
  height: number;
  contentWidth: number;
}

interface LogicalAnchor {
  page: number;
  pageProgress: number;
  viewportXRatio: number;
  viewportYRatio: number;
  horizontalProgress: number;
}

function imageHeightRatio(image: GalleryImage): number {
  if (image.width > 0 && image.height > 0) return image.height / image.width;
  return 1;
}

function pageAtOffset(offsets: number[], offset: number): number {
  if (offsets.length <= 1) return 0;
  const contentOffset = Math.max(0, offset);
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (offsets[mid] <= contentOffset) low = mid;
    else high = mid - 1;
  }
  return Math.min(low, offsets.length - 2);
}

function readViewport(node: HTMLDivElement): { width: number; height: number } {
  const rect = node.getBoundingClientRect();
  return {
    width: Math.max(1, node.clientWidth || rect.width || window.innerWidth || 1),
    height: Math.max(1, node.clientHeight || rect.height || window.innerHeight || 1),
  };
}

function writeScroll(node: HTMLDivElement, left: number, top: number) {
  node.scrollLeft = Math.max(0, left);
  node.scrollTop = Math.max(0, top);
  // Programmatic scroll events are asynchronous in browsers and absent in
  // jsdom. Dispatching one now also lets the virtualizer mount the destination
  // rows before the next frame (important for a far-away initial page).
  node.dispatchEvent(new Event('scroll'));
}

function VirtualPageRow({
  row,
  url,
  offlineSource,
  measureElement,
  onNaturalRatio,
  pageLabel,
}: {
  row: VirtualItem;
  url: string;
  offlineSource?: OfflineImageSource;
  measureElement: (node: HTMLDivElement | null) => void;
  onNaturalRatio: (index: number, width: number, height: number) => void;
  pageLabel: string;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [naturalSizeReady, setNaturalSizeReady] = useState(false);
  const setRowRef = useCallback(
    (node: HTMLDivElement | null) => {
      rowRef.current = node;
      measureElement(node);
    },
    [measureElement],
  );

  useLayoutEffect(() => {
    if (!naturalSizeReady) return;
    const rowNode = rowRef.current;
    if (!rowNode) return;
    const rafId = requestAnimationFrame(() => measureElement(rowNode));
    return () => cancelAnimationFrame(rafId);
  }, [measureElement, naturalSizeReady]);

  const handleLoadCapture = (event: SyntheticEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) return;
    if (target.naturalWidth > 0 && target.naturalHeight > 0) {
      onNaturalRatio(row.index, target.naturalWidth, target.naturalHeight);
    }
    setNaturalSizeReady(true);
  };

  return (
    <div
      ref={setRowRef}
      data-index={row.index}
      data-page-index={row.index}
      role="group"
      aria-label={`${pageLabel} ${row.index + 1}`}
      onLoadCapture={handleLoadCapture}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        // Reserve the aspect-ratio estimate only until the actual image has
        // decoded. Afterwards natural image layout becomes authoritative and
        // the virtualizer measures the row, avoiding fallback-ratio distortion.
        height: naturalSizeReady ? undefined : row.size,
        transform: `translateY(${row.start}px)`,
      }}
    >
      {offlineSource ? (
        <OfflineImage
          source={offlineSource}
          alt={`${pageLabel} ${row.index + 1}`}
          className="h-auto w-full select-none"
          loading="lazy"
          draggable={false}
        />
      ) : (
        <AbortableImage
          src={url}
          alt={`${pageLabel} ${row.index + 1}`}
          className="h-auto w-full select-none"
          loading="lazy"
          draggable={false}
        />
      )}
    </div>
  );
}

export function ScrollReader({
  images,
  initialPage,
  onScrollPositionChange,
  onVisiblePageChange,
  scrollCallbackRef,
  offlineUrls,
  offlineSources,
}: {
  images: GalleryImage[];
  initialPage?: number;
  onScrollPositionChange: (p: number) => void;
  onVisiblePageChange: (page: number) => void;
  scrollCallbackRef: RefCallback<HTMLDivElement>;
  /** When provided, use these blob URLs instead of fetching from the network. */
  offlineUrls?: string[];
  /** Fast offline sources from useOfflineImages. */
  offlineSources?: OfflineImageSource[];
}) {
  const t = useT();
  const localRef = useRef<HTMLDivElement | null>(null);
  const scrolledRef = useRef(false);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [naturalRatios, setNaturalRatios] = useState(
    () => new Map<number, { hash: string; ratio: number }>(),
  );
  const scrollZoom = useSettingsStore((s) => s.scrollZoom);

  // Keep callback identities out of the scroll/virtualizer lifecycles.
  const onVisiblePageChangeRef = useRef(onVisiblePageChange);
  useEffect(() => {
    onVisiblePageChangeRef.current = onVisiblePageChange;
  });

  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      localRef.current = node;
      scrollCallbackRef(node);
    },
    [scrollCallbackRef],
  );

  const {
    urls,
    normalizedOfflineSources,
    loading: imageSourcesLoading,
    error: imageSourceError,
    retry: retryImageSources,
  } = useReaderImageSources({ images, offlineUrls, offlineSources });

  const pageRatios = useMemo(
    () =>
      images.map((image, index) => {
        const measured = naturalRatios.get(index);
        return measured?.hash === image.hash ? measured.ratio : imageHeightRatio(image);
      }),
    [images, naturalRatios],
  );
  const pageOffsets = useMemo(() => {
    const offsets = new Array<number>(pageRatios.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < pageRatios.length; i++) offsets[i + 1] = offsets[i] + pageRatios[i];
    return offsets;
  }, [pageRatios]);

  const measuredViewportWidth = Math.max(1, viewport.width);
  const measuredViewportHeight = Math.max(1, viewport.height);
  const contentWidth = measuredViewportWidth * scrollZoom;
  const estimateRowSize = useCallback(
    (index: number) => contentWidth * (pageRatios[index] ?? 1),
    [contentWidth, pageRatios],
  );
  const getRowKey = useCallback(
    (index: number) => `${images[index]?.hash ?? 'page'}-${index}`,
    [images],
  );

  const rowVirtualizer = useVirtualizer({
    count: urls.length,
    getScrollElement: () => localRef.current,
    estimateSize: estimateRowSize,
    getItemKey: getRowKey,
    overscan: ROW_OVERSCAN,
    initialRect: { width: measuredViewportWidth, height: measuredViewportHeight },
    useFlushSync: false,
  });

  const metricsRef = useRef<ViewportMetrics>({
    width: viewport.width,
    height: viewport.height,
    contentWidth,
  });
  const previousPageRatiosRef = useRef(pageRatios);
  const pendingAnchorRef = useRef<LogicalAnchor | null>(null);
  const anchorRafRef = useRef<number | null>(null);
  const restoringAnchorRef = useRef(false);
  const lastVisiblePageRef = useRef(-1);
  const lastRequestedPageRef = useRef(initialPage);
  const programmaticPageRef = useRef<number | null>(null);
  const programmaticSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const programmaticSafetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userScrolledRef = useRef(false);

  const captureAnchor = useCallback(
    (
      node: HTMLDivElement,
      metrics: ViewportMetrics,
      viewportXRatio = 0.5,
      viewportYRatio = 0,
    ): LogicalAnchor | null => {
      if (!pageRatios.length || metrics.contentWidth <= 0) return null;
      const viewportX = metrics.width * viewportXRatio;
      const viewportY = metrics.height * viewportYRatio;
      const logicalY = (node.scrollTop + viewportY) / metrics.contentWidth;
      const page = pageAtOffset(pageOffsets, logicalY);
      const ratio = pageRatios[page] || 1;
      const centeredMargin = Math.max(0, (metrics.width - metrics.contentWidth) / 2);
      return {
        page,
        pageProgress: Math.min(1, Math.max(0, (logicalY - pageOffsets[page]) / ratio)),
        viewportXRatio,
        viewportYRatio,
        horizontalProgress: Math.min(
          1,
          Math.max(0, (node.scrollLeft + viewportX - centeredMargin) / metrics.contentWidth),
        ),
      };
    },
    [pageOffsets, pageRatios],
  );

  const handleNaturalRatio = useCallback(
    (index: number, width: number, height: number) => {
      const image = images[index];
      if (!image || width <= 0 || height <= 0) return;
      const ratio = height / width;
      if (!Number.isFinite(ratio) || Math.abs((pageRatios[index] ?? 1) - ratio) < 0.001) return;

      const node = localRef.current;
      if (node) pendingAnchorRef.current ??= captureAnchor(node, metricsRef.current);
      setNaturalRatios((current) => {
        const previous = current.get(index);
        if (previous?.hash === image.hash && Math.abs(previous.ratio - ratio) < 0.001) {
          return current;
        }
        const next = new Map(current);
        next.set(index, { hash: image.hash, ratio });
        return next;
      });
    },
    [captureAnchor, images, pageRatios],
  );

  const visiblePageAt = useCallback(
    (scrollTop: number, viewportHeight: number, width: number) => {
      if (!pageRatios.length || width <= 0) return -1;
      const top = Math.max(0, scrollTop);
      const bottom = top + Math.max(1, viewportHeight);
      let index = pageAtOffset(pageOffsets, top / width);
      let bestPage = index;
      let bestRatio = -1;
      while (index < pageRatios.length) {
        const pageTop = pageOffsets[index] * width;
        if (pageTop >= bottom) break;
        const pageBottom = pageOffsets[index + 1] * width;
        const overlap = Math.max(0, Math.min(pageBottom, bottom) - Math.max(pageTop, top));
        // Preserve the old IntersectionObserver contract: pick the page with
        // the largest visible fraction, not simply the most visible pixels.
        // Otherwise a fully visible short/landscape page loses to a sliver of
        // each much taller neighbor and reading progress skips that page.
        const ratio = overlap / Math.max(1, pageBottom - pageTop);
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestPage = index;
        }
        index++;
      }
      return bestPage;
    },
    [pageOffsets, pageRatios.length],
  );

  const reportVisiblePage = useCallback(
    (node: HTMLDivElement, width = contentWidth, height = measuredViewportHeight) => {
      if (programmaticPageRef.current != null) return;
      const page = visiblePageAt(node.scrollTop, height, width);
      if (page >= 0 && page !== lastVisiblePageRef.current) {
        lastVisiblePageRef.current = page;
        onVisiblePageChangeRef.current(page);
      }
    },
    [contentWidth, measuredViewportHeight, visiblePageAt],
  );

  const finishProgrammaticPageScroll = useCallback(
    (node: HTMLDivElement) => {
      if (programmaticPageRef.current == null) return;
      if (programmaticSettleTimerRef.current != null) {
        clearTimeout(programmaticSettleTimerRef.current);
      }
      if (programmaticSafetyTimerRef.current != null) {
        clearTimeout(programmaticSafetyTimerRef.current);
      }
      programmaticSettleTimerRef.current = null;
      programmaticSafetyTimerRef.current = null;
      programmaticPageRef.current = null;
      reportVisiblePage(node);
    },
    [reportVisiblePage],
  );

  // Track the real scrollport. A width change alters every aspect-ratio row, so
  // capture the current logical location before updating the estimates.
  useLayoutEffect(() => {
    const node = localRef.current;
    if (!node) return;

    const updateViewport = (next: { width: number; height: number }) => {
      const previous = metricsRef.current;
      if (next.width !== previous.width && previous.width > 0) {
        pendingAnchorRef.current ??= captureAnchor(node, previous);
      }
      setViewport((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };

    updateViewport(readViewport(node));
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      // Percentage child widths resolve against the scrollport's client box,
      // not the observer's border box (which may include a desktop scrollbar).
      updateViewport(readViewport(node));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [captureAnchor, urls.length]);

  // Invalidate every cached estimate after zoom/rotation. Restore the same page
  // and normalized position inside that page after the new total height lands.
  useLayoutEffect(() => {
    const node = localRef.current;
    if (!node || viewport.width <= 0 || viewport.height <= 0) return;
    const previous = metricsRef.current;
    const next: ViewportMetrics = {
      width: viewport.width,
      height: viewport.height,
      contentWidth,
    };
    const widthChanged = Math.abs(previous.contentWidth - next.contentWidth) > 0.5;
    const geometryChanged = previousPageRatiosRef.current !== pageRatios;
    const viewportChanged = previous.width !== next.width || previous.height !== next.height;

    if (widthChanged || geometryChanged) {
      if (previous.width > 0) pendingAnchorRef.current ??= captureAnchor(node, previous);
      rowVirtualizer.measure();
    }
    previousPageRatiosRef.current = pageRatios;
    metricsRef.current = next;

    const anchor = previous.width > 0 ? pendingAnchorRef.current : null;
    pendingAnchorRef.current = null;
    if (!anchor || (!widthChanged && !geometryChanged)) {
      if (viewportChanged) reportVisiblePage(node, next.contentWidth, next.height);
      return;
    }

    const page = Math.min(anchor.page, Math.max(0, pageRatios.length - 1));
    const logicalY = pageOffsets[page] + anchor.pageProgress * (pageRatios[page] || 1);
    const targetTop = logicalY * next.contentWidth - anchor.viewportYRatio * next.height;
    const centeredMargin = Math.max(0, (next.width - next.contentWidth) / 2);
    const targetLeft =
      centeredMargin +
      anchor.horizontalProgress * next.contentWidth -
      anchor.viewportXRatio * next.width;

    restoringAnchorRef.current = true;
    const apply = () => writeScroll(node, targetLeft, targetTop);
    apply();
    if (anchorRafRef.current != null) cancelAnimationFrame(anchorRafRef.current);
    anchorRafRef.current = requestAnimationFrame(() => {
      apply();
      anchorRafRef.current = requestAnimationFrame(() => {
        apply();
        restoringAnchorRef.current = false;
        reportVisiblePage(node, next.contentWidth, next.height);
        anchorRafRef.current = null;
      });
    });
  }, [
    captureAnchor,
    contentWidth,
    pageOffsets,
    pageRatios,
    reportVisiblePage,
    rowVirtualizer,
    viewport.height,
    viewport.width,
  ]);

  useEffect(
    () => () => {
      if (anchorRafRef.current != null) cancelAnimationFrame(anchorRafRef.current);
      if (programmaticSettleTimerRef.current != null) {
        clearTimeout(programmaticSettleTimerRef.current);
      }
      if (programmaticSafetyTimerRef.current != null) {
        clearTimeout(programmaticSafetyTimerRef.current);
      }
      anchorRafRef.current = null;
      programmaticSettleTimerRef.current = null;
      programmaticSafetyTimerRef.current = null;
      programmaticPageRef.current = null;
      restoringAnchorRef.current = false;
    },
    [],
  );

  // Exact aspect-ratio estimates let a requested page be addressed even though
  // its DOM row is intentionally not mounted yet. User-scroll page echoes are
  // ignored; a genuine external request goes through the virtualizer directly.
  useEffect(() => {
    if (!urls.length || viewport.width <= 0) return;
    const node = localRef.current;
    if (!node) return;
    const page = Math.min(Math.max(0, initialPage ?? 0), urls.length - 1);
    const requestedPageChanged = initialPage !== lastRequestedPageRef.current;
    lastRequestedPageRef.current = initialPage;

    if (scrolledRef.current) {
      if (!requestedPageChanged) return;
      if (page === lastVisiblePageRef.current) return;

      programmaticPageRef.current = page;
      if (programmaticSettleTimerRef.current != null) {
        clearTimeout(programmaticSettleTimerRef.current);
      }
      if (programmaticSafetyTimerRef.current != null) {
        clearTimeout(programmaticSafetyTimerRef.current);
      }
      if (typeof node.scrollTo === 'function') {
        const behavior = userScrolledRef.current ? 'smooth' : 'auto';
        rowVirtualizer.scrollToIndex(page, { align: 'start', behavior });
        // scrollend is authoritative where available. A debounced scroll-event
        // fallback below covers older WebViews. This safety valve never saves
        // an intermediate page: it lands on the requested row synchronously.
        programmaticSafetyTimerRef.current = setTimeout(
          () => {
            const requestedPage = programmaticPageRef.current;
            if (requestedPage == null) return;
            rowVirtualizer.scrollToIndex(requestedPage, { align: 'start', behavior: 'auto' });
            finishProgrammaticPageScroll(node);
          },
          behavior === 'smooth' ? 2000 : 200,
        );
      } else {
        // jsdom and very old WebViews have no scrollTo method. The exact
        // aspect-ratio offset is equivalent to scrollToIndex in this layout.
        writeScroll(node, node.scrollLeft, pageOffsets[page] * contentWidth);
        programmaticPageRef.current = null;
        reportVisiblePage(node);
      }
      return;
    }

    if (page === 0) {
      scrolledRef.current = true;
      reportVisiblePage(node);
      return;
    }

    const totalHeight =
      (pageOffsets[urls.length] ?? pageOffsets[pageOffsets.length - 1] ?? 0) * contentWidth;
    const maxScrollTop = Math.max(0, totalHeight - measuredViewportHeight);
    const target = Math.min(pageOffsets[page] * contentWidth, maxScrollTop);
    let rafId = 0;
    let attempts = 0;
    const align = () => {
      if (Math.abs(node.scrollTop - target) <= 1) {
        scrolledRef.current = true;
        reportVisiblePage(node);
        return;
      }
      writeScroll(node, node.scrollLeft, target);
      if (++attempts < 30) rafId = requestAnimationFrame(align);
      else {
        scrolledRef.current = true;
        reportVisiblePage(node);
      }
    };
    rafId = requestAnimationFrame(align);
    return () => cancelAnimationFrame(rafId);
  }, [
    contentWidth,
    initialPage,
    finishProgrammaticPageScroll,
    measuredViewportHeight,
    pageOffsets,
    reportVisiblePage,
    rowVirtualizer,
    urls.length,
    viewport.width,
  ]);

  useEffect(() => {
    const node = localRef.current;
    if (!node) return;
    let ticking = false;
    let rafId: number | null = null;
    const onScroll = () => {
      if (ticking) return;
      if (
        programmaticPageRef.current == null &&
        !restoringAnchorRef.current &&
        scrolledRef.current
      ) {
        userScrolledRef.current = true;
      }
      ticking = true;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        onScrollPositionChange(node.scrollTop);
        if (programmaticPageRef.current != null) {
          if (programmaticSettleTimerRef.current != null) {
            clearTimeout(programmaticSettleTimerRef.current);
          }
          programmaticSettleTimerRef.current = setTimeout(
            () => finishProgrammaticPageScroll(node),
            120,
          );
        } else if (!restoringAnchorRef.current && scrolledRef.current) {
          reportVisiblePage(node);
        }
        ticking = false;
      });
    };
    const onScrollEnd = () => finishProgrammaticPageScroll(node);
    node.addEventListener('scroll', onScroll, { passive: true });
    node.addEventListener('scrollend', onScrollEnd);
    if (scrolledRef.current) reportVisiblePage(node);
    return () => {
      node.removeEventListener('scroll', onScroll);
      node.removeEventListener('scrollend', onScrollEnd);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [finishProgrammaticPageScroll, onScrollPositionChange, reportVisiblePage, urls.length]);

  // Desktop zoom + pan. No platform detection: the input type selects behavior:
  //  - Ctrl/Command + wheel (including trackpad pinch) zooms under the cursor.
  //  - Mouse click-drag pans. Double-click resets to fit.
  // Touch fires none of these, so mobile stays fully native (pinch + scroll).
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  useEffect(() => {
    const node = localRef.current;
    if (!node) return;

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const { scrollZoom: oldZoom, setScrollZoom } = useSettingsStore.getState();
      const newZoom = clampZoom(oldZoom * Math.exp(-event.deltaY * 0.0015));
      if (newZoom === oldZoom) return;
      const rect = node.getBoundingClientRect();
      const metrics = metricsRef.current;
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      pendingAnchorRef.current = captureAnchor(
        node,
        metrics,
        Math.min(1, Math.max(0, x / Math.max(1, metrics.width))),
        Math.min(1, Math.max(0, y / Math.max(1, metrics.height))),
      );
      setScrollZoom(newZoom);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      dragRef.current = {
        x: event.clientX,
        y: event.clientY,
        left: node.scrollLeft,
        top: node.scrollTop,
      };
      node.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      event.preventDefault();
      node.scrollLeft = drag.left - (event.clientX - drag.x);
      node.scrollTop = drag.top - (event.clientY - drag.y);
    };
    const endDrag = (event: PointerEvent) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
    };
    const onDblClick = () => useSettingsStore.getState().setScrollZoom(1);

    node.addEventListener('wheel', onWheel, { passive: false });
    node.addEventListener('pointerdown', onPointerDown);
    node.addEventListener('pointermove', onPointerMove);
    node.addEventListener('pointerup', endDrag);
    node.addEventListener('pointercancel', endDrag);
    node.addEventListener('dblclick', onDblClick);
    return () => {
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', endDrag);
      node.removeEventListener('pointercancel', endDrag);
      node.removeEventListener('dblclick', onDblClick);
    };
  }, [captureAnchor, urls.length]);

  if (imageSourceError) {
    return (
      <ReaderLoadState
        state="error"
        onRetry={retryImageSources}
        detail={imageSourceError.message}
      />
    );
  }
  if (imageSourcesLoading) return <ReaderLoadState state="loading" />;
  if (!urls.length) return <ReaderLoadState state="empty" />;

  const virtualRows = rowVirtualizer.getVirtualItems();

  return (
    <div
      ref={setRef}
      className="h-dvh cursor-grab overflow-auto focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white active:cursor-grabbing"
      role="region"
      aria-label={t('reader.pages')}
      tabIndex={0}
    >
      <div
        className="relative mx-auto"
        data-virtual-total-size={rowVirtualizer.getTotalSize()}
        style={{ width: `${scrollZoom * 100}%`, height: rowVirtualizer.getTotalSize() }}
      >
        {virtualRows.map((row) => (
          <VirtualPageRow
            key={row.key}
            row={row}
            url={urls[row.index]}
            offlineSource={normalizedOfflineSources?.[row.index]}
            measureElement={rowVirtualizer.measureElement}
            onNaturalRatio={handleNaturalRatio}
            pageLabel={t('reader.page')}
          />
        ))}
      </div>
    </div>
  );
}
