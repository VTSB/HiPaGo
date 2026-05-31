/** Pure cache-size helpers (no store/platform imports — safe to unit-test alone). */

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Megabytes (user input) -> bytes. Negative/NaN clamp to 0 (off). */
export function mbToBytes(mb: number): number {
  if (!Number.isFinite(mb) || mb <= 0) return 0;
  return Math.round(mb) * MB;
}

/** Bytes -> whole megabytes (for the input field). */
export function bytesToMb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round(bytes / MB);
}

/** Human-readable size for the usage display. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes >= GB) {
    const gb = bytes / GB;
    return `${Math.round(gb * 10) / 10} GB`;
  }
  return `${Math.max(1, Math.round(bytes / MB))} MB`;
}
