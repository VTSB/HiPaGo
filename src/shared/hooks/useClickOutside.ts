'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Calls `callback` when a mousedown event occurs outside all provided refs.
 */
export function useClickOutside(
  refs: RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[],
  callback: () => void,
): void {
  useEffect(() => {
    const refArray = Array.isArray(refs) ? refs : [refs];
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      const isOutside = refArray.every(
        (ref) => !ref.current?.contains(target),
      );
      if (isOutside) callback();
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [refs, callback]);
}
