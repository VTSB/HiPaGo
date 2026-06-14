'use client';

import { useDownloadProgressStore, selectQueueActive } from '@/lib/store/download-progress';

/**
 * A small accent dot shown on the Library nav destination (desktop header link
 * and mobile bottom tab) whenever the download queue is non-empty (active or
 * pending). Subscribes to a cheap boolean selector so it only re-renders on the
 * empty↔non-empty flip, not on every progress tick. Renders nothing when the
 * queue is empty. The caller positions it (relative parent + absolute dot).
 */
export function QueueBadgeDot({ className = '' }: { className?: string }) {
  const active = useDownloadProgressStore(selectQueueActive);
  if (!active) return null;
  return (
    <span
      aria-hidden="true"
      className={`h-2 w-2 rounded-full bg-blue-500 ring-2 ring-white dark:ring-zinc-950 ${className}`}
    />
  );
}
