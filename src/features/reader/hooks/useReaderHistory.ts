'use client';

import { useCallback } from 'react';

/**
 * Reader-internal back navigation. One reader session corresponds to one
 * history entry (the navigation that opened the reader), so a single back
 * press exits to the detail page. Page flips are pure store mutations and
 * are not reflected in the URL — the reader's own reading-progress save
 * handles resume across sessions.
 */
export function useReaderHistory() {
  const goBack = useCallback(() => {
    window.history.back();
  }, []);

  return { goBack };
}
