// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';

// Full module shape so the shared mock registry (isolate:false) never exposes a
// real export when another file's platform mock wins the worker.
vi.mock('@/lib/utils/platform', () => ({
  isNativePlatform: vi.fn(() => false),
  isTauri: vi.fn(() => false),
  isCapacitor: vi.fn(() => false),
  isAndroid: vi.fn(() => false),
}));

import { isNativePlatform } from '@/lib/utils/platform';
import {
  resolveLtnUrl,
  resolveTagIndexUrl,
  resolveImgUrl,
  getNativeHeaders,
  resolveThumbnailUrl,
} from '../url-resolver';

describe('url-resolver', () => {
  afterEach(() => {
    vi.mocked(isNativePlatform).mockReset();
  });

  describe('resolveLtnUrl', () => {
    it('returns proxy path in browser', () => {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      expect(resolveLtnUrl('gg.js')).toBe('/api/hitomi/gg.js');
    });

    it('returns direct CDN URL on native', () => {
      vi.mocked(isNativePlatform).mockReturnValue(true);
      expect(resolveLtnUrl('gg.js')).toBe(
        'https://ltn.gold-usergeneratedcontent.net/gg.js',
      );
    });

    it('handles paths with subdirectories', () => {
      vi.mocked(isNativePlatform).mockReturnValue(true);
      expect(resolveLtnUrl('galleriesindex/galleries.v42.index')).toBe(
        'https://ltn.gold-usergeneratedcontent.net/galleriesindex/galleries.v42.index',
      );
    });
  });

  describe('resolveTagIndexUrl', () => {
    it('returns proxy path in browser', () => {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      expect(resolveTagIndexUrl('global/t/e.json')).toBe(
        '/api/tagindex/global/t/e.json',
      );
    });

    it('returns direct tagindex URL on native', () => {
      vi.mocked(isNativePlatform).mockReturnValue(true);
      expect(resolveTagIndexUrl('global/t/e.json')).toBe(
        'https://tagindex.hitomi.la/global/t/e.json',
      );
    });
  });

  describe('resolveImgUrl', () => {
    it('returns proxy path in browser', () => {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      expect(resolveImgUrl('a1', 'images/path/hash.avif')).toBe(
        '/api/img/a1/images/path/hash.avif',
      );
    });

    it('returns direct CDN URL on native', () => {
      vi.mocked(isNativePlatform).mockReturnValue(true);
      expect(resolveImgUrl('a1', 'images/path/hash.avif')).toBe(
        'https://a1.gold-usergeneratedcontent.net/images/path/hash.avif',
      );
    });

    it('handles thumbnail subdomain', () => {
      vi.mocked(isNativePlatform).mockReturnValue(true);
      expect(resolveImgUrl('tn', 'avifsmalltn/a/bc/hash.avif')).toBe(
        'https://tn.gold-usergeneratedcontent.net/avifsmalltn/a/bc/hash.avif',
      );
    });
  });

  describe('getNativeHeaders', () => {
    it('returns empty object in browser', () => {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      expect(getNativeHeaders()).toEqual({});
    });

    it('returns Referer and Origin on native', () => {
      vi.mocked(isNativePlatform).mockReturnValue(true);
      const headers = getNativeHeaders();
      expect(headers.Referer).toBe('https://hitomi.la/');
      expect(headers.Origin).toBe('https://hitomi.la');
    });
  });

  describe('resolveThumbnailUrl', () => {
    it('converts direct CDN thumbnail URL to proxy URL in browser', () => {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      const cdnUrl = 'https://tn.gold-usergeneratedcontent.net/avifsmalltn/4/23/abcdef1234.avif';
      expect(resolveThumbnailUrl(cdnUrl)).toBe(
        '/api/img/tn/avifsmalltn/4/23/abcdef1234.avif',
      );
    });

    it('converts CDN thumbnail URL with different subdomain', () => {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      const cdnUrl = 'https://btn.gold-usergeneratedcontent.net/smalltn/4/23/hash123.jpg';
      expect(resolveThumbnailUrl(cdnUrl)).toBe(
        '/api/img/btn/smalltn/4/23/hash123.jpg',
      );
    });

    it('returns already-proxied URL unchanged', () => {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      const proxied = '/api/img/tn/avifsmalltn/4/23/hash.avif';
      expect(resolveThumbnailUrl(proxied)).toBe(proxied);
    });

    it('returns empty string unchanged', () => {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      expect(resolveThumbnailUrl('')).toBe('');
    });

    it('passes through to direct CDN on native platform', () => {
      vi.mocked(isNativePlatform).mockReturnValue(true);
      const cdnUrl = 'https://tn.gold-usergeneratedcontent.net/avifsmalltn/4/23/hash.avif';
      expect(resolveThumbnailUrl(cdnUrl)).toBe(cdnUrl);
    });
  });
});
