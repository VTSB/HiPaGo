'use client';

import { useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useGalleryColumns } from '../hooks/useGalleryColumns';

export interface SavedGalleryGridHandle {
  scrollToItem: (index: number) => void;
}

export interface SavedGalleryGroup<T> {
  key: string;
  label?: string;
  items: T[];
}

interface Props<T> {
  groups: SavedGalleryGroup<T>[];
  renderItem: (item: T, index: number) => ReactNode;
  getItemKey: (item: T) => string | number;
  ref?: Ref<SavedGalleryGridHandle>;
}

type Row<T> =
  | { key: string; label: string }
  | { key: string; items: T[]; startIndex: number };

/** One virtual window across all date groups. Keeping a virtualizer per date
 * would retain overscan cards in every group, growing memory during long scrolls. */
export function SavedGalleryGrid<T>({ groups, renderItem, getItemKey, ref }: Props<T>) {
  const columns = useGalleryColumns();
  const containerRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ width: 0, scrollMargin: 0, mobile: true });

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => {
      const width = element.clientWidth;
      const scrollMargin = element.getBoundingClientRect().top + window.scrollY;
      const mobile = window.innerWidth < 640;
      setLayout((previous) =>
        previous.width === width && previous.scrollMargin === scrollMargin && previous.mobile === mobile
          ? previous
          : { width, scrollMargin, mobile },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    // A download queue or another preceding section can move the grid without
    // resizing it. Watch the containing flow too, including ancestors above
    // intermediate wrappers, so virtual offsets follow those layout changes.
    for (let target: HTMLElement | null = element; target; target = target.parentElement) {
      observer.observe(target);
    }
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  const rows = useMemo(() => {
    const result: Row<T>[] = [];
    let startIndex = 0;
    for (const group of groups) {
      if (group.items.length === 0) continue;
      if (group.label) result.push({ key: `heading:${group.key}`, label: group.label });
      for (let offset = 0; offset < group.items.length; offset += columns) {
        result.push({
          key: `row:${group.key}:${offset}`,
          items: group.items.slice(offset, offset + columns),
          startIndex: startIndex + offset,
        });
      }
      startIndex += group.items.length;
    }
    return result;
  }, [groups, columns]);

  const gap = layout.mobile ? 8 : 12;
  const rowGap = layout.mobile ? 10 : 12;
  const width = layout.width || (typeof window === 'undefined' ? 400 : window.innerWidth - 16);
  const cardHeight = ((width - gap * (columns - 1)) / columns) * 1.5;
  const estimateSize = useCallback(
    (index: number) => 'label' in rows[index] ? 44 : cardHeight + rowGap,
    [rows, cardHeight, rowGap],
  );
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize,
    getItemKey: (index) => rows[index].key,
    overscan: 3,
    scrollMargin: layout.scrollMargin,
    scrollPaddingStart: 80,
  });

  useLayoutEffect(() => {
    virtualizer.measure();
  }, [virtualizer, estimateSize]);

  useImperativeHandle(ref, () => ({
    scrollToItem(index) {
      const rowIndex = rows.findIndex((row) =>
        'items' in row && index >= row.startIndex && index < row.startIndex + row.items.length,
      );
      if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: 'start' });
    },
  }), [rows, virtualizer]);

  return (
    <div ref={containerRef} className="-mx-2 sm:mx-0" style={{ overflowAnchor: 'none' }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          return (
            <div key={virtualRow.key} style={{
              position: 'absolute', top: 0, left: 0, width: '100%',
              height: virtualRow.size,
              transform: `translateY(${virtualRow.start - layout.scrollMargin}px)`,
            }}>
              {'label' in row ? (
                <div className="flex h-full items-center gap-3 px-2 pb-2 pt-2 sm:px-0">
                  <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                  <span className="shrink-0 text-sm font-medium text-zinc-500 dark:text-zinc-400">{row.label}</span>
                  <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, columnGap: gap }}>
                  {row.items.map((item, offset) => (
                    <div key={getItemKey(item)} data-item-index={row.startIndex + offset}>
                      {renderItem(item, row.startIndex + offset)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
