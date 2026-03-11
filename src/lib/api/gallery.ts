import { apiClient } from './client';
import {
  parseGalleryJson,
  parseGalleryBlockHtml,
  galleryInfoToBlock,
  galleryInfoToImages,
  parseLanguageSupport,
  parseIndexVersion,
} from './parser';
import { fetchGalleryIds, fetchGalleryIdsByTag } from './nozomi';
import type {
  GalleryBlock,
  GalleryIds,
  GalleryImages,
  GalleryInfo,
} from '@/lib/utils/types';
import { GalleryBlockType, ImageType } from '@/lib/utils/types';
import { PAGE_SIZE } from '@/lib/utils/constants';
import { saveGalleryImages, getGalleryImages as getGalleryImagesFromDb } from '@/lib/db/gallery';

export async function fetchGalleryInfo(id: number): Promise<GalleryInfo> {
  const text = await apiClient.fetchLtnText(`galleries/${id}.js`);
  return parseGalleryJson(text);
}

export async function fetchGalleryBlockHtmlById(
  id: number,
  signal?: AbortSignal,
): Promise<GalleryBlock> {
  try {
    const text = await apiClient.fetchLtnText(`galleryblock/${id}.html`, { signal });
    return parseGalleryBlockHtml(text, id);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    // Recoverable: HTML fetch/parse failed — return placeholder so UI still renders
    return createFailedBlock(id);
  }
}

export async function fetchGalleryBlockDetailed(
  id: number,
): Promise<GalleryBlock> {
  try {
    const info = await fetchGalleryInfo(id);
    return galleryInfoToBlock(info);
  } catch {
    // Recoverable: detailed gallery info fetch failed — return placeholder block
    return createFailedBlock(id);
  }
}

export async function fetchGalleryImages(id: number): Promise<GalleryImages> {
  const info = await fetchGalleryInfo(id);
  return galleryInfoToImages(info);
}

export async function fetchGalleryImagesCached(id: number): Promise<GalleryImages> {
  // Try DB cache first
  const cached = await getGalleryImagesFromDb(id);
  if (cached) {
    return {
      id,
      images: cached.map(file => {
        const types = new Set<ImageType>([ImageType.ORIGINAL]);
        if (file.haswebp) types.add(ImageType.WEBP);
        if (file.hasavif) types.add(ImageType.AVIF);
        return { name: file.name, hash: file.hash, width: file.width, height: file.height, types };
      }),
    };
  }

  // Fetch from API and cache
  const info = await fetchGalleryInfo(id);
  await saveGalleryImages(id, info.files);
  return galleryInfoToImages(info);
}

export async function fetchBrowseIds(
  language: string,
  page: number,
  pageSize: number = PAGE_SIZE,
  sort?: import('@/lib/utils/types').SortOrder,
): Promise<GalleryIds> {
  return fetchGalleryIds('index', language, page, pageSize, sort);
}

export async function fetchSearchIds(
  tagType: string,
  tag: string,
  language: string,
  page: number,
  pageSize: number = PAGE_SIZE,
): Promise<GalleryIds> {
  return fetchGalleryIdsByTag(tagType, tag, language, page, pageSize);
}

export async function fetchLanguages(): Promise<string[]> {
  const text = await apiClient.fetchLtnText('language_support.js');
  return parseLanguageSupport(text);
}

export async function fetchIndexVersion(name: string): Promise<string> {
  const text = await apiClient.fetchLtnText(
    `${name}/version?_=${Date.now()}`,
  );
  return parseIndexVersion(text);
}

export function createLoadingBlock(id: number): GalleryBlock {
  return {
    id,
    type: GalleryBlockType.LOADING,
    title: '',
    date: new Date(),
    tags: {},
    thumbnail: '',
    related: [],
  };
}

function createFailedBlock(id: number): GalleryBlock {
  return {
    id,
    type: GalleryBlockType.FAILED,
    title: '',
    date: new Date(),
    tags: {},
    thumbnail: '',
    related: [],
  };
}
