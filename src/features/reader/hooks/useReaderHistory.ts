'use client';

import { useCallback } from 'react';

function detailHref(galleryId: number): string {
  // Static native builds use query routes; the web route keeps the gallery id
  // in the path. Return to the matching detail route in either deployment.
  if (window.location.pathname === '/reader' || window.location.pathname === '/reader/') {
    return `/gallery?id=${galleryId}`;
  }
  return `/gallery/${galleryId}`;
}

function replaceAndNotify(href: string): void {
  window.history.replaceState(window.history.state, '', href);
  window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
}

/**
 * Reader-internal back navigation. Normal reader sessions consume their one
 * app-history entry. Cold/direct reader entries replace themselves with the
 * matching gallery detail so Back never becomes a no-op or exits the app.
 */
export function useReaderHistory(galleryId: number) {
  const goBack = useCallback(() => {
    const nativeCanGoBack = window.__hipagoCanGoBack?.();
    const hasBackEntry =
      nativeCanGoBack !== undefined ? nativeCanGoBack : window.history.length > 1;

    if (hasBackEntry) {
      window.history.back();
      return;
    }

    replaceAndNotify(detailHref(galleryId));
  }, [galleryId]);

  return { goBack };
}
