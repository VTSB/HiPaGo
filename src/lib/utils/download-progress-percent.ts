import type { DownloadProgress } from '@/lib/utils/download-zip';

/**
 * Convert page progress to a user-facing integer percentage.
 *
 * Rounded values below completion are capped at 99 so a large gallery cannot
 * display 100% while its final page is still pending (for example 199/200).
 */
export function downloadProgressPercent(progress: DownloadProgress): number {
  const { current, total } = progress;
  if (total <= 0) return 0;
  if (current >= total) return 100;
  return Math.min(99, Math.max(0, Math.round((current / total) * 100)));
}
