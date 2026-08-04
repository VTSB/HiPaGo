'use client';

import { useEffect, useEffectEvent } from 'react';

interface ReaderKeyboardOptions {
  mode: 'page' | 'scroll';
  onNextPage: () => void;
  onPrevPage: () => void;
  onFirstPage: () => void;
  onLastPage: () => void;
  onBack: () => void;
  onToggleFullscreen?: () => void;
}

export function isEditableReaderTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest(
      'input, textarea, select, button, a[href], summary, [role="button"], [role="link"], [contenteditable="true"], [contenteditable="plaintext-only"]',
    ) !== null
  );
}

/**
 * Reader-scoped keyboard controls with one stable global subscription.
 *
 * Continuous-scroll mode intentionally leaves vertical/navigation keys to the
 * focused scroll container. Horizontal arrows and PageUp/PageDown still provide
 * explicit page jumps, while page mode also supports the familiar vertical,
 * Space, Home, and End shortcuts.
 */
export function useReaderKeyboard(options: ReaderKeyboardOptions): void {
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      isEditableReaderTarget(event.target)
    ) {
      return;
    }

    const handlers = options;
    let action: (() => void) | undefined;

    switch (event.key) {
      case 'ArrowRight':
      case 'PageDown':
        action = handlers.onNextPage;
        break;
      case 'ArrowLeft':
      case 'PageUp':
        action = handlers.onPrevPage;
        break;
      case 'ArrowDown':
        if (handlers.mode === 'page') action = handlers.onNextPage;
        break;
      case 'ArrowUp':
        if (handlers.mode === 'page') action = handlers.onPrevPage;
        break;
      case ' ':
      case 'Spacebar':
        if (handlers.mode === 'page') {
          action = event.shiftKey ? handlers.onPrevPage : handlers.onNextPage;
        }
        break;
      case 'Home':
        if (handlers.mode === 'page') action = handlers.onFirstPage;
        break;
      case 'End':
        if (handlers.mode === 'page') action = handlers.onLastPage;
        break;
      case 'Escape':
        if (event.repeat) return;
        action = handlers.onBack;
        break;
      case 'F11':
        if (event.repeat) return;
        action = handlers.onToggleFullscreen;
        break;
    }

    if (!action) return;
    event.preventDefault();
    action();
  });

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
