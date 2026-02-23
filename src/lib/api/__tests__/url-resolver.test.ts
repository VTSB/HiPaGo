// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/utils/platform', () => ({
  isNativePlatform: vi.fn(),
}));

import { isNativePlatform } from '@/lib/utils/platform';
import {
  resolveLtnUrl,
  resolveTagIndexUrl,
  resolveImgUrl,
  getNativeHeaders,
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
});
