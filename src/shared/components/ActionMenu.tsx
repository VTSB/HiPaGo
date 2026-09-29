'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import type { GalleryActionAnchor } from '@/shared/hooks/useGalleryActions';
import { useT } from '@/lib/i18n/useT';

export interface ActionMenuItem {
  key: string;
  label: string;
  action: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

let bodyLockCount = 0;
let savedBodyOverflow = '';

export function lockOverlayScroll(): () => void {
  if (bodyLockCount === 0) savedBodyOverflow = document.body.style.overflow;
  bodyLockCount += 1;
  document.body.style.overflow = 'hidden';
  return () => {
    bodyLockCount -= 1;
    if (bodyLockCount === 0) document.body.style.overflow = savedBodyOverflow;
  };
}

export function restoreOverlayFocus(previous: HTMLElement | null): void {
  queueMicrotask(() => {
    const overlays = document.querySelectorAll<HTMLElement>(
      '[data-hipago-overlay]:not([aria-hidden="true"])',
    );
    const top = overlays[overlays.length - 1];
    if (top && !top.contains(document.activeElement))
      top.querySelector<HTMLElement>('button:not(:disabled),input:not(:disabled)')?.focus();
    else if (!top && previous?.isConnected) previous.focus();
  });
}

export function ActionMenu({
  title,
  anchor,
  items,
  error,
  busy,
  onClose,
  children,
  active = true,
  dialog = false,
}: {
  title: string;
  anchor?: GalleryActionAnchor;
  items: ActionMenuItem[];
  error?: string | null;
  busy?: boolean;
  onClose: () => void;
  children?: ReactNode;
  active?: boolean;
  dialog?: boolean;
}) {
  const mobile = useIsMobile();
  const t = useT();
  const menu = useRef<HTMLDivElement>(null);
  const originalFocus = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState({ left: anchor?.x ?? 16, top: anchor?.y ?? 80 });

  useLayoutEffect(() => {
    if (mobile) return;
    const frame = requestAnimationFrame(() => {
      const rect = menu.current?.getBoundingClientRect();
      if (rect)
        setPosition({
          left: Math.max(
            8,
            Math.min(
              anchor?.x ?? (window.innerWidth - rect.width) / 2,
              window.innerWidth - rect.width - 8,
            ),
          ),
          top: Math.max(8, Math.min(anchor?.y ?? 80, window.innerHeight - rect.height - 8)),
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [mobile, anchor, children, items.length, error]);

  useEffect(() => {
    if (!active) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!originalFocus.current) originalFocus.current = previousFocus;
    const unlockScroll = lockOverlayScroll();
    (menu.current?.querySelector<HTMLElement>('button:not(:disabled),input:not(:disabled)') ?? menu.current)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      const buttons = Array.from(
        menu.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),a[href]',
        ) ?? [],
      );
      if (!buttons.length) {
        if (event.key === 'Tab') { event.preventDefault(); menu.current?.focus(); }
        return;
      }
      const current = buttons.indexOf(document.activeElement as HTMLElement);
      if (event.key === 'Tab') {
        event.preventDefault();
        buttons[(current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
      } else if (
        !mobile &&
        !dialog &&
        ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
      ) {
        event.preventDefault();
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next].focus();
      }
    };
    const onBack = (event: Event) => {
      const overlays = document.querySelectorAll('[data-hipago-overlay]');
      if (overlays[overlays.length - 1] !== menu.current?.parentElement) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('hipago:overlay-back', onBack);
    return () => {
      unlockScroll();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('hipago:overlay-back', onBack);
      restoreOverlayFocus(originalFocus.current);
    };
  }, [active, mobile, dialog, onClose, busy]);

  return createPortal(
    <div
      data-hipago-overlay="gallery-actions"
      className="fixed inset-0 z-[100]"
      aria-hidden={!active || undefined}
    >
      <div
        className={`absolute inset-0 ${mobile ? 'bg-black/40 backdrop-blur-sm' : ''}`}
        onPointerDown={() => {
          if (active && !busy) onClose();
        }}
      />
      <div
        ref={menu}
        tabIndex={-1}
        role={mobile || dialog ? 'dialog' : 'menu'}
        aria-modal={mobile || dialog ? true : undefined}
        aria-label={title}
        aria-busy={busy}
        className={
          mobile
            ? 'absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-3xl bg-white px-3 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] shadow-2xl dark:bg-zinc-900'
            : 'absolute w-80 max-w-[calc(100vw-16px)] max-h-[calc(100dvh-16px)] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-2 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900'
        }
        style={mobile ? undefined : position}
      >
        {mobile && (
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        )}
        <div className="flex items-start gap-2 px-3 pb-3">
          <h2 className="line-clamp-2 flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {title}
          </h2>
          <button
            type="button"
            aria-label={t('actions.cancel')}
            onClick={onClose}
            disabled={busy}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            ×
          </button>
        </div>
        {error && (
          <p
            role="alert"
            className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          >
            {error}
          </p>
        )}
        {children}
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            role={mobile || dialog ? undefined : 'menuitem'}
            disabled={busy || item.disabled}
            onClick={item.action}
            className={`flex min-h-11 w-full items-center rounded-lg px-3 py-2.5 text-left text-sm font-medium disabled:opacity-40 ${item.destructive ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/50' : 'text-zinc-800 hover:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-800'}`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
