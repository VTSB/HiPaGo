import { isNativePlatform } from '@/lib/utils/platform';

const CDN = 'gold-usergeneratedcontent.net';

export function resolveLtnUrl(path: string): string {
  return isNativePlatform() ? `https://ltn.${CDN}/${path}` : `/api/hitomi/${path}`;
}

export function resolveTagIndexUrl(path: string): string {
  return isNativePlatform()
    ? `https://tagindex.hitomi.la/${path}`
    : `/api/tagindex/${path}`;
}

export function resolveImgUrl(subdomain: string, restPath: string): string {
  return isNativePlatform()
    ? `https://${subdomain}.${CDN}/${restPath}`
    : `/api/img/${subdomain}/${restPath}`;
}

const CDN_HOST_SUFFIX = `.${CDN}`;

/**
 * Convert a direct CDN thumbnail URL to a proxied /api/img/ URL.
 * Input:  https://{subdomain}.gold-usergeneratedcontent.net/{restPath}
 * Output: /api/img/{subdomain}/{restPath}  (browser)
 *         unchanged                         (native)
 *
 * Already-proxied or non-CDN URLs are returned unchanged.
 */
export function resolveThumbnailUrl(url: string): string {
  if (!url) return url;
  if (!url.startsWith('https://')) return url;
  const withoutScheme = url.slice('https://'.length);
  const slashIdx = withoutScheme.indexOf('/');
  if (slashIdx === -1) return url;
  const host = withoutScheme.slice(0, slashIdx);
  const restPath = withoutScheme.slice(slashIdx + 1);
  if (!host.endsWith(CDN_HOST_SUFFIX)) return url;
  const subdomain = host.slice(0, host.length - CDN_HOST_SUFFIX.length);
  return resolveImgUrl(subdomain, restPath);
}

export function getNativeHeaders(): Record<string, string> {
  if (!isNativePlatform()) return {};
  return {
    Referer: 'https://hitomi.la/',
    Origin: 'https://hitomi.la',
  };
}
