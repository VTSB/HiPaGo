import type { GalleryFile, GalleryImage, GgConfig } from './types';
import { ImageType } from './types';
import { resolveImgUrl } from '@/lib/api/url-resolver';

/**
 * Parse the gg.js configuration file from hitomi.la.
 *
 * New format (object literal):
 *   gg = { m: function(g) { var o = DEFAULT; switch(g) { case N: o = VALUE; break; } return o; },
 *          s: function(h) { ... }, b: 'PATH/' }
 *
 * Old format (separate vars):
 *   var b = 'PATH/'; var o = N; case N: ...
 *
 * Both formats are supported.
 */
export function parseGgJs(text: string): GgConfig {
  const config: GgConfig = {
    pathCode: '',
    mDefault: 1,
    mCases: new Set(),
    mCaseValue: 0,
  };

  // Extract pathCode: b: 'value' (new) or var b = 'value' (old)
  const bMatch = /b:\s*'([^']*)'/.exec(text) || /var\s+b\s*=\s*'([^']*)'/.exec(text);
  if (bMatch) {
    config.pathCode = bMatch[1].replace(/\/$/, '');
  }

  // Extract default m value: var o = N (the initial assignment before switch)
  const oDefaultMatch = /var\s+o\s*=\s*(\d+)/.exec(text);
  if (oDefaultMatch) {
    config.mDefault = parseInt(oDefaultMatch[1], 10);
  }

  // Extract all case numbers
  const caseRegex = /case\s+(\d+):/g;
  let match;
  while ((match = caseRegex.exec(text)) !== null) {
    config.mCases.add(parseInt(match[1], 10));
  }

  // Extract the case assignment value: o = VALUE inside switch
  const caseAssignMatch = /case\s+\d+:[^}]*?o\s*=\s*(\d+)\s*;?\s*break/.exec(text);
  if (caseAssignMatch) {
    config.mCaseValue = parseInt(caseAssignMatch[1], 10);
  } else if (config.mCases.size > 0) {
    // Fallback: assume opposite of default
    config.mCaseValue = 1 - config.mDefault;
  }

  return config;
}

/**
 * Compute gg.m(g) - the subdomain routing value for a given hash code.
 * Returns mCaseValue for hash codes in the case set, mDefault otherwise.
 */
export function ggM(g: number, config: GgConfig): number {
  return config.mCases.has(g) ? config.mCaseValue : config.mDefault;
}

/**
 * Compute the imageHashCode from a file hash.
 * Takes the last 3 hex chars of the hash: last + second-to-last two,
 * then parses as a hex integer.
 * Equivalent to hitomi's gg.s(hash) but returns a number (gg.s returns decimal string).
 */
export function imageHashCode(hash: string): number {
  // hash.slice(-1) = last char, hash.slice(-3, -1) = 2 chars before last
  return parseInt(hash.slice(-1) + hash.slice(-3, -1), 16);
}

/**
 * Get the full image URL for a gallery file.
 *
 * Based on hitomi.la's url_from_hash + url_from_url logic:
 * - images: subdomain = (1+m),  path = images/{pathCode}/{hashCode}/{hash}.{ext}
 * - webp:   subdomain = w(1+m), path = {pathCode}/{hashCode}/{hash}.webp
 * - avif:   subdomain = a(1+m), path = {pathCode}/{hashCode}/{hash}.avif
 *
 * All URLs go through /api/img proxy which handles CORS and CDN routing.
 * In Tauri/Capacitor dev mode, the Next.js dev server provides these routes.
 */
export function getImageUrl(
  image: GalleryFile,
  config: GgConfig,
  preferredFormat?: 'auto' | 'avif' | 'webp' | 'original',
): string {
  let ext: string;
  let dir: string; // 'images' for originals, '' for webp/avif (matches hitomi's url_from_hash)
  let subPrefix: string; // 'w' for webp, 'a' for avif, '' for originals

  if (preferredFormat === 'original') {
    ext = image.name.split('.').pop() || 'jpg';
    dir = 'images';
    subPrefix = '';
  } else if (preferredFormat === 'webp') {
    if (image.haswebp) { ext = 'webp'; dir = ''; subPrefix = 'w'; }
    else { ext = image.name.split('.').pop() || 'jpg'; dir = 'images'; subPrefix = ''; }
  } else if (preferredFormat === 'avif') {
    if (image.hasavif) { ext = 'avif'; dir = ''; subPrefix = 'a'; }
    else if (image.haswebp) { ext = 'webp'; dir = ''; subPrefix = 'w'; }
    else { ext = image.name.split('.').pop() || 'jpg'; dir = 'images'; subPrefix = ''; }
  } else {
    // 'auto' or undefined - avif > webp > original
    if (image.hasavif) { ext = 'avif'; dir = ''; subPrefix = 'a'; }
    else if (image.haswebp) { ext = 'webp'; dir = ''; subPrefix = 'w'; }
    else { ext = image.name.split('.').pop() || 'jpg'; dir = 'images'; subPrefix = ''; }
  }

  const g = imageHashCode(image.hash);
  const m = ggM(g, config);
  const subdomain = subPrefix + (1 + m);
  const path = `${config.pathCode}/${g}/${image.hash}`;
  const dirPrefix = dir ? `${dir}/` : '';

  return resolveImgUrl(subdomain, `${dirPrefix}${path}.${ext}`);
}

/**
 * Get a thumbnail URL for a gallery file.
 * Thumbnails use 'tn' as proxy subdomain (the img proxy resolves to actual atn/btn).
 * Path: {format}tn/{hash[-1]}/{hash[-3:-1]}/{hash}.{ext}
 * This matches hitomi's real_full_path_from_hash: hash.replace(/^.*(..)(.)$/, '$2/$1/'+hash)
 */
export function getThumbnailUrl(
  image: GalleryFile,
  size: 'small' | 'big' = 'small',
): string {
  const hash = image.hash;
  const hashPath = `${hash.slice(-1)}/${hash.slice(-3, -1)}/${hash}`;

  // hitomi.la always rewrites smalltn → avifsmalltn via rewrite_tn_paths,
  // so use avif thumbnail whenever hasavif or hasavifsmalltn is set
  if (image.hasavifsmalltn || image.hasavif) {
    return resolveImgUrl('tn', `avif${size}tn/${hashPath}.avif`);
  }
  if (image.haswebp) {
    return resolveImgUrl('tn', `webp${size}tn/${hashPath}.webp`);
  }

  const ext = image.name.split('.').pop() || 'jpg';
  return resolveImgUrl('tn', `${size}tn/${hashPath}.${ext}`);
}

/**
 * Get the best available image URL with gg.js config.
 * Prefers avif > webp > original format, or uses preferredFormat if specified.
 */
export function getBestImageUrl(
  image: GalleryFile,
  config: GgConfig,
  preferredFormat?: 'auto' | 'avif' | 'webp' | 'original',
): string {
  return getImageUrl(image, config, preferredFormat);
}

/**
 * Convert a GalleryImage (with Set-based types) to GalleryFile (with numeric flags).
 */
export function galleryImageToFile(image: GalleryImage): GalleryFile {
  return {
    width: image.width,
    height: image.height,
    name: image.name,
    hash: image.hash,
    haswebp: image.types.has(ImageType.WEBP) ? 1 : 0,
    hasavif: image.types.has(ImageType.AVIF) ? 1 : 0,
    hasavifsmalltn: image.types.has(ImageType.AVIFSMALLTN) ? 1 : 0,
  };
}

