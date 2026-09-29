'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useGalleryActions, type GalleryActionGallery } from '@/shared/hooks/useGalleryActions';

/** Gesture target only; the menu itself lives above the virtualized card grid. */
export function GalleryActionTarget({
  gallery,
  selected,
  focusable = false,
  onSelect,
  onBeginSelection,
  children,
}: {
  gallery: GalleryActionGallery;
  selected?: boolean;
  focusable?: boolean;
  onSelect?: () => void;
  onBeginSelection?: () => void;
  children: ReactNode;
}) {
  const actions = useGalleryActions();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const suppressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const target = useRef<HTMLDivElement>(null);

  const cancelHold = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };

  useEffect(() => {
    const cancel = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      origin.current = null;
    };
    window.addEventListener('scroll', cancel, true);
    return () => {
      cancel();
      if (suppressTimer.current) clearTimeout(suppressTimer.current);
      window.removeEventListener('scroll', cancel, true);
    };
  }, []);

  return (
    <div
      ref={target}
      tabIndex={onSelect || focusable ? 0 : undefined}
      role={onSelect ? 'checkbox' : focusable ? 'group' : undefined}
      aria-checked={onSelect ? !!selected : undefined}
      aria-label={onSelect || focusable ? gallery.title || `#${gallery.id}` : undefined}
      className="relative select-none"
      style={{ WebkitTouchCallout: 'none' }}
      data-selected={onSelect ? selected : undefined}
      onPointerDown={(event) => {
        cancelHold();
        suppressClick.current = false;
        if (
          event.button !== 0 ||
          event.isPrimary === false ||
          onSelect ||
          (event.pointerType !== 'touch' && event.pointerType !== 'pen')
        )
          return;
        origin.current = { x: event.clientX, y: event.clientY };
        timer.current = setTimeout(() => {
          timer.current = null;
          suppressClick.current = true;
          actions.open(gallery, undefined, onBeginSelection);
        }, 500);
      }}
      onPointerMove={(event) => {
        if (
          origin.current &&
          Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 10
        )
          cancelHold();
      }}
      onPointerUp={() => {
        cancelHold();
        if (suppressClick.current) {
          if (suppressTimer.current) clearTimeout(suppressTimer.current);
          suppressTimer.current = setTimeout(() => {
            suppressClick.current = false;
          }, 800);
        }
      }}
      onPointerCancel={cancelHold}
      onClickCapture={(event) => {
        if (suppressClick.current) {
          event.preventDefault();
          event.stopPropagation();
          suppressClick.current = false;
          return;
        }
        if (onSelect && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
          event.preventDefault();
          event.stopPropagation();
          onSelect();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        const openedByHold = suppressClick.current;
        const touchHolding = origin.current !== null;
        cancelHold();
        if (touchHolding) suppressClick.current = true;
        // A touch hold already opened the sheet; do not reopen on its native callout.
        if (!openedByHold)
          actions.open(
            gallery,
            touchHolding ? undefined : { x: event.clientX, y: event.clientY },
            onBeginSelection,
          );
      }}
      onKeyDown={(event) => {
        if (onSelect && (event.key === ' ' || event.key === 'Enter')) {
          event.preventDefault();
          onSelect();
          return;
        }
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault();
        const rect = target.current?.getBoundingClientRect();
        actions.open(
          gallery,
          rect ? { x: rect.left + 16, y: rect.top + 16 } : undefined,
          onBeginSelection,
        );
      }}
    >
      {children}
      {onSelect && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border-2 shadow ${selected ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900' : 'border-white bg-black/40 text-transparent'}`}
        >
          ✓
        </span>
      )}
    </div>
  );
}
