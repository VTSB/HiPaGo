import { zipSync, strToU8 } from 'fflate';
import { getImageUrl } from './image-url';
import { apiClient } from '@/lib/api/client';
import type { GalleryFile, GgConfig } from './types';

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'gallery';
}

function padIndex(idx: number, total: number): string {
  const digits = String(total).length;
  return String(idx).padStart(digits, '0');
}

export interface DownloadProgress {
  current: number;
  total: number;
}

export async function downloadGalleryAsZip(
  galleryId: number,
  title: string,
  files: GalleryFile[],
  ggConfig: GgConfig,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const total = files.length;
  const entries: Record<string, Uint8Array> = {};

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const file = files[i];
    const url = getImageUrl(file, ggConfig, 'webp');
    const res = await apiClient.fetchUrl(url, { signal });
    const buf = await res.arrayBuffer();
    // Derive extension from actual content type or URL
    const ct = res.headers.get('content-type') || '';
    let ext = 'webp';
    if (ct.includes('avif')) ext = 'avif';
    else if (ct.includes('png')) ext = 'png';
    else if (ct.includes('jpeg') || ct.includes('jpg')) ext = 'jpg';
    else if (ct.includes('gif')) ext = 'gif';
    else if (!file.haswebp) ext = file.name.split('.').pop() || 'jpg';
    const name = `${padIndex(i + 1, total)}.${ext}`;
    entries[name] = new Uint8Array(buf);

    onProgress?.({ current: i + 1, total });
  }

  const zipped = zipSync(entries, { level: 0 }); // no compression, images are already compressed

  const safeName = sanitizeFilename(title);
  const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${galleryId} ${safeName}.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
}
