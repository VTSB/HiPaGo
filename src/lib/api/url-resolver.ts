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

export function getNativeHeaders(): Record<string, string> {
  if (!isNativePlatform()) return {};
  return {
    Referer: 'https://hitomi.la/',
    Origin: 'https://hitomi.la',
  };
}
