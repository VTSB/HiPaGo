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
  GalleryFile,
  GalleryIds,
  GalleryImages,
  GalleryInfo,
} from '@/lib/utils/types';
import { GalleryBlockType, ImageType } from '@/lib/utils/types';
import { PAGE_SIZE } from '@/lib/utils/constants';
import { saveGalleryImages, getGalleryImages as getGalleryImagesFromDb } from '@/lib/db/gallery';

// Cache 404'd gallery IDs to avoid repeated requests for deleted galleries
const notFoundIds = new Set<number>();

export async function fetchGalleryInfo(id: number): Promise<GalleryInfo> {
  if (notFoundIds.has(id)) {
    throw Object.assign(new Error(`Gallery ${id} not found (cached)`), { status: 404 });
  }
  try {
    const text = await apiClient.fetchLtnText(`galleries/${id}.js`);
    return parseGalleryJson(text);
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 404) {
      notFoundIds.add(id);
    }
    throw e;
  }
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

export function filesToGalleryImages(id: number, files: GalleryFile[]): GalleryImages {
  return {
    id,
    images: files.map(file => {
      const types = new Set<ImageType>([ImageType.ORIGINAL]);
      if (file.haswebp) types.add(ImageType.WEBP);
      if (file.hasavif) types.add(ImageType.AVIF);
      return { name: file.name, hash: file.hash, width: file.width, height: file.height, types };
    }),
  };
}

export async function fetchGalleryImagesCached(id: number): Promise<GalleryImages> {
  // Try DB cache first
  const cached = await getGalleryImagesFromDb(id);
  if (cached) {
    return filesToGalleryImages(id, cached);
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

const versionCache = new Map<string, { value: string; at: number; promise?: Promise<string> }>();
const VERSION_TTL = 60_000; // 1 minute

export async function fetchIndexVersion(name: string): Promise<string> {
  const cached = versionCache.get(name);

  // TTL cache hit
  if (cached && Date.now() - cached.at < VERSION_TTL) {
    return cached.promise ?? cached.value;
  }

  // Promise dedup: reuse in-flight request
  if (cached?.promise) return cached.promise;

  const promise = apiClient
    .fetchLtnText(`${name}/version?_=${Date.now()}`)
    .then(parseIndexVersion)
    .then((version) => {
      versionCache.set(name, { value: version, at: Date.now() });
      return version;
    })
    .catch((err) => {
      versionCache.delete(name);
      throw err;
    });

  versionCache.set(name, { value: '', at: 0, promise });
  return promise;
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
