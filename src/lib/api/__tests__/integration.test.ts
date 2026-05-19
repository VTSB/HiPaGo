// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fetchGalleryInfo } from '../gallery';
import { galleryInfoToImages, galleryInfoToBlock, categorizeTags } from '../parser';
import { getImageUrl, getThumbnailUrl, parseGgJs } from '@/lib/utils/image-url';
import { fetchGalleryIds } from '../nozomi';
import { clearGgConfigCache, getGgConfig } from '../client';
import { GalleryBlockType, ImageType, TagType } from '@/lib/utils/types';

// Mock gg.js content
const mockGgJsV1 = `
var o = 0;
var b = '1719741324/';
case 97:
case 253:
case 300:
`;

const mockGgJsV2 = `
var o = 1;
var b = '9876543210/';
case 100:
case 200:
case 300:
`;

// Mock gallery JSON
const mockGalleryJson = `var galleryinfo = {
  "id": "12345",
  "title": "Test Gallery",
  "japanese_title": "テストギャラリー",
  "language": "japanese",
  "language_localname": "日本語",
  "type": "doujinshi",
  "date": "2024-01-15 12:30:00-09",
  "files": [
    {"width":1280,"height":1800,"haswebp":1,"hasavifsmalltn":1,"hasavif":1,"name":"001.jpg","hash":"abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"},
    {"width":1280,"height":1800,"haswebp":1,"hasavifsmalltn":0,"hasavif":0,"name":"002.png","hash":"1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"},
    {"width":800,"height":600,"haswebp":0,"hasavifsmalltn":0,"hasavif":0,"name":"003.gif","hash":"fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321"}
  ],
  "tags": [
    {"male":"1","female":"0","url":"tag/sample%20male-all.html","tag":"sample male"},
    {"male":"0","female":"1","url":"tag/sample%20female-all.html","tag":"sample female"},
    {"male":"0","female":"0","url":"artist/testartist-all.html","tag":"testartist"}
  ]
}`;

// Create mock nozomi binary data (big-endian int32 array)
function createNozomiData(ids: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(ids.length * 4);
  const view = new DataView(buffer);
  ids.forEach((id, index) => {
    view.setInt32(index * 4, id, false); // big-endian
  });
  return buffer;
}

describe('Integration Tests - Full Pipeline', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearGgConfigCache();

    mockFetch = vi.fn((url: string) => {
      const urlStr = url;

      // Route based on URL pattern
      if (urlStr.includes('/api/hitomi/gg.js')) {
        return Promise.resolve(new Response(mockGgJsV1, { status: 200 }));
      }

      if (urlStr.includes('/api/hitomi/galleries/12345.js')) {
        return Promise.resolve(new Response(mockGalleryJson, { status: 200 }));
      }

      if (urlStr.includes('/api/hitomi/index-japanese.nozomi')) {
        const ids = [12345, 67890, 11111];
        const buffer = createNozomiData(ids);
        const totalBytes = 1000 * 4; // Simulate 1000 total IDs
        return Promise.resolve(
          new Response(buffer, {
            status: 206,
            headers: {
              'Content-Range': `bytes 0-11/${totalBytes}`,
            },
          })
        );
      }

      // Default 404
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    vi.stubGlobal('fetch', mockFetch);
  });

  describe('1. Full Gallery Info → Image URL Pipeline', () => {
    it('should fetch gallery info and generate correct image URLs with gg.js config', async () => {
      // Fetch gallery info (internal modules work with real code)
      const info = await fetchGalleryInfo(12345);

      // Verify gallery info parsed correctly
      expect(info.id).toBe(12345);
      expect(info.title).toBe('Test Gallery');
      expect(info.japaneseTitle).toBe('テストギャラリー');
      expect(info.language).toBe('japanese');
      expect(info.type).toBe('doujinshi');
      expect(info.files).toHaveLength(3);

      // Convert to images
      const images = galleryInfoToImages(info);
      expect(images.id).toBe(12345);
      expect(images.images).toHaveLength(3);

      // Get gg.js config
      const config = await getGgConfig();
      expect(config.pathCode).toBe('1719741324');
      expect(config.mDefault).toBe(0);
      expect(config.mCases.has(97)).toBe(true);
      expect(config.mCases.has(253)).toBe(true);

      // Test image URL generation for different formats
      const file1 = info.files[0]; // hasavif=1
      const url1 = getImageUrl(file1, config);
      expect(url1).toContain('/api/img/');
      expect(url1).toContain('.avif');
      expect(url1).toMatch(/^\/api\/img\/a[12]\//); // subdomain starts with 'a'
      expect(url1).toContain(config.pathCode);

      const file2 = info.files[1]; // haswebp=1, no avif
      const url2 = getImageUrl(file2, config);
      expect(url2).toContain('/api/img/');
      expect(url2).toContain('.webp');
      expect(url2).toMatch(/^\/api\/img\/w[12]\//); // subdomain starts with 'w'

      const file3 = info.files[2]; // no webp, no avif (gif)
      const url3 = getImageUrl(file3, config);
      expect(url3).toContain('/api/img/');
      expect(url3).toContain('/images/');
      expect(url3).toContain('.gif');
      expect(url3).toMatch(/^\/api\/img\/[12]\//); // subdomain is just (1+m) for originals
    });

    it('should generate correct thumbnail URLs', async () => {
      const info = await fetchGalleryInfo(12345);

      // File with avifsmalltn
      const file1 = info.files[0];
      const thumb1 = getThumbnailUrl(file1, 'small');
      expect(thumb1).toMatch(/^\/api\/img\/tn\/avifsmalltn\//);
      expect(thumb1).toContain('.avif');
      const hash1 = file1.hash;
      expect(thumb1).toContain(`${hash1.slice(-1)}/${hash1.slice(-3, -1)}/${hash1}.avif`);

      // File with webp but no avifsmalltn
      const file2 = info.files[1];
      const thumb2 = getThumbnailUrl(file2, 'small');
      expect(thumb2).toMatch(/^\/api\/img\/tn\/webpsmalltn\//);
      expect(thumb2).toContain('.webp');

      // File with neither (original format)
      const file3 = info.files[2];
      const thumb3 = getThumbnailUrl(file3, 'small');
      expect(thumb3).toMatch(/^\/api\/img\/tn\/smalltn\//);
      expect(thumb3).toContain('.gif');

      // Test big thumbnail
      const bigThumb = getThumbnailUrl(file1, 'big');
      expect(bigThumb).toMatch(/^\/api\/img\/tn\/avifbigtn\//);
    });
  });

  describe('2. Gallery Info → Block Conversion Pipeline', () => {
    it('should convert gallery info to detailed block', async () => {
      const info = await fetchGalleryInfo(12345);
      const block = galleryInfoToBlock(info);

      expect(block.id).toBe(12345);
      expect(block.type).toBe(GalleryBlockType.DETAILED);
      expect(block.title).toBe('Test Gallery');
      expect(block.thumbnail).toContain('/api/img/tn/');
      expect(block.thumbnail).toContain('.avif'); // First file has avifsmalltn
      expect(block.related).toEqual([]);

      // Verify tags categorized correctly
      expect(block.tags[TagType.MALE]).toEqual(['sample male']);
      expect(block.tags[TagType.FEMALE]).toEqual(['sample female']);
      expect(block.tags[TagType.ARTIST]).toEqual(['testartist']);

      // Verify date parsing
      expect(block.date).toBeInstanceOf(Date);
      expect(block.date.getFullYear()).toBe(2024);
    });

    it('should categorize tags correctly by type', () => {
      const tags = [
        { male: '1', female: '0', url: 'tag/male-tag.html', tag: 'male-tag' },
        { male: '0', female: '1', url: 'tag/female-tag.html', tag: 'female-tag' },
        { male: '0', female: '0', url: 'artist/artist-name.html', tag: 'artist-name' },
        { male: '0', female: '0', url: 'series/series-name.html', tag: 'series-name' },
        { male: '0', female: '0', url: 'character/char-name.html', tag: 'char-name' },
        { male: '0', female: '0', url: 'tag/generic.html', tag: 'generic' },
      ];

      const categorized = categorizeTags(tags);

      expect(categorized[TagType.MALE]).toEqual(['male-tag']);
      expect(categorized[TagType.FEMALE]).toEqual(['female-tag']);
      expect(categorized[TagType.ARTIST]).toEqual(['artist-name']);
      expect(categorized[TagType.SERIES]).toEqual(['series-name']);
      expect(categorized[TagType.CHARACTER]).toEqual(['char-name']);
      expect(categorized[TagType.TAG]).toEqual(['generic']);
    });
  });

  describe('3. Gallery Info → Images Pipeline (all format types)', () => {
    it('should convert gallery info to images with correct type flags', async () => {
      const info = await fetchGalleryInfo(12345);
      const images = galleryInfoToImages(info);

      expect(images.images).toHaveLength(3);

      // File 1: hasavif=1, haswebp=1
      const img1 = images.images[0];
      expect(img1.name).toBe('001.jpg');
      expect(img1.hash).toBe('abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
      expect(img1.width).toBe(1280);
      expect(img1.height).toBe(1800);
      expect(img1.types.has(ImageType.ORIGINAL)).toBe(true);
      expect(img1.types.has(ImageType.WEBP)).toBe(true);
      expect(img1.types.has(ImageType.AVIF)).toBe(true);

      // File 2: haswebp=1, no avif
      const img2 = images.images[1];
      expect(img2.types.has(ImageType.ORIGINAL)).toBe(true);
      expect(img2.types.has(ImageType.WEBP)).toBe(true);
      expect(img2.types.has(ImageType.AVIF)).toBe(false);

      // File 3: no webp, no avif
      const img3 = images.images[2];
      expect(img3.types.has(ImageType.ORIGINAL)).toBe(true);
      expect(img3.types.has(ImageType.WEBP)).toBe(false);
      expect(img3.types.has(ImageType.AVIF)).toBe(false);
    });

    it('should generate different URLs based on format availability', async () => {
      const info = await fetchGalleryInfo(12345);
      const config = await getGgConfig();

      // File with avif: should use avif (no /avif/ dir in URL, just .avif ext)
      const file1 = info.files[0];
      const url1 = getImageUrl(file1, config);
      expect(url1).toContain('.avif');
      expect(url1).toMatch(/^\/api\/img\/a[12]\//);

      // File with webp but no avif: should use webp (no /webp/ dir in URL)
      const file2 = info.files[1];
      const url2 = getImageUrl(file2, config);
      expect(url2).toContain('.webp');
      expect(url2).toMatch(/^\/api\/img\/w[12]\//);


      // File with neither: should use original format
      const file3 = info.files[2];
      const url3 = getImageUrl(file3, config);
      expect(url3).toContain('/images/');
      expect(url3).toContain('.gif');
    });
  });

  describe('4. Nozomi Binary Data Pipeline', () => {
    it('should fetch and parse gallery IDs from nozomi binary data', async () => {
      const result = await fetchGalleryIds('index', 'japanese', 0);

      // Verify IDs parsed correctly
      expect(result.idList).toEqual([12345, 67890, 11111]);

      // Verify total count extracted from Content-Range
      expect(result.length).toBe(1000); // 1000 * 4 / 4 = 1000

      // Verify fetch was called with correct range
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/hitomi/index-japanese.nozomi'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Range: 'bytes=0-99', // 25 items * 4 bytes = 100 bytes (0-99)
          }),
        })
      );
    });

    it('should calculate correct pagination ranges', async () => {
      // Page 0
      await fetchGalleryIds('index', 'japanese', 0, 25);
      expect(mockFetch).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Range: 'bytes=0-99',
          }),
        })
      );

      // Page 1
      await fetchGalleryIds('index', 'japanese', 1, 25);
      expect(mockFetch).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Range: 'bytes=100-199',
          }),
        })
      );

      // Page 2
      await fetchGalleryIds('index', 'japanese', 2, 25);
      expect(mockFetch).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Range: 'bytes=200-299',
          }),
        })
      );
    });
  });

  describe('5. Proxy URL Construction Verification', () => {
    it('should construct all URLs through proxy prefix', async () => {
      const info = await fetchGalleryInfo(12345);
      const config = await getGgConfig();

      // All image URLs should start with /api/img/
      for (const file of info.files) {
        const imageUrl = getImageUrl(file, config);
        expect(imageUrl).toMatch(/^\/api\/img\//);

        const thumbUrl = getThumbnailUrl(file);
        expect(thumbUrl).toMatch(/^\/api\/img\/tn\//);
      }
    });

    it('should construct image URLs with correct pattern', async () => {
      const info = await fetchGalleryInfo(12345);
      const config = await getGgConfig();
      const file = info.files[0];
      const url = getImageUrl(file, config);

      // Pattern: /api/img/{subdomain}/{pathCode}/{hashCode}/{hash}.{ext}
      // avif/webp have no dir prefix, only originals use /images/ prefix
      const pattern = /^\/api\/img\/([a-z]\d+)\/(\d+)\/(\d+)\/([a-f0-9]+)\.(\w+)$/;
      expect(url).toMatch(pattern);

      const match = pattern.exec(url);
      expect(match).not.toBeNull();
      if (match) {
        expect(match[2]).toBe('1719741324'); // pathCode
        expect(match[4]).toBe(file.hash); // hash
        expect(match[5]).toBe('avif'); // ext
      }
    });

    it('should construct thumbnail URLs with correct pattern', async () => {
      const info = await fetchGalleryInfo(12345);
      const file = info.files[0];
      const url = getThumbnailUrl(file, 'small');

      // Pattern: /api/img/tn/{format}{size}tn/{hash[-1]}/{hash[-3:-1]}/{hash}.{ext}
      const pattern = /^\/api\/img\/tn\/(\w+)\/([a-f0-9])\/([a-f0-9]{2})\/([a-f0-9]+)\.(\w+)$/;
      expect(url).toMatch(pattern);

      const match = pattern.exec(url);
      expect(match).not.toBeNull();
      if (match) {
        expect(match[1]).toBe('avifsmalltn'); // format
        expect(match[2]).toBe(file.hash.slice(-1)); // last char
        expect(match[3]).toBe(file.hash.slice(-3, -1)); // 2 chars before last
        expect(match[4]).toBe(file.hash); // full hash
      }
    });
  });

  describe('6. gg.js Config → Image URL Consistency', () => {
    it('should produce different URLs with different gg.js configs', async () => {
      // First config
      const info = await fetchGalleryInfo(12345);
      const config1 = await getGgConfig();
      const file = info.files[0];
      const url1 = getImageUrl(file, config1);

      expect(url1).toContain('1719741324'); // pathCode from mockGgJsV1

      // Clear cache and switch to different gg.js
      clearGgConfigCache();
      mockFetch.mockImplementation((url: string) => {
        const urlStr = url;
        if (urlStr.includes('/api/hitomi/gg.js')) {
          return Promise.resolve(new Response(mockGgJsV2, { status: 200 }));
        }
        if (urlStr.includes('/api/hitomi/galleries/12345.js')) {
          return Promise.resolve(new Response(mockGalleryJson, { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      // Second config
      const config2 = await getGgConfig();
      const url2 = getImageUrl(file, config2);

      expect(url2).toContain('9876543210'); // pathCode from mockGgJsV2
      expect(url1).not.toBe(url2); // URLs should be different
      expect(config1.pathCode).not.toBe(config2.pathCode);
    });

    it('should parse gg.js config correctly', () => {
      const config1 = parseGgJs(mockGgJsV1);
      expect(config1.pathCode).toBe('1719741324');
      expect(config1.mDefault).toBe(0);
      expect(config1.mCaseValue).toBe(1);
      expect(config1.mCases.has(97)).toBe(true);
      expect(config1.mCases.has(253)).toBe(true);
      expect(config1.mCases.has(300)).toBe(true);

      const config2 = parseGgJs(mockGgJsV2);
      expect(config2.pathCode).toBe('9876543210');
      expect(config2.mDefault).toBe(1);
      expect(config2.mCaseValue).toBe(0);
      expect(config2.mCases.has(100)).toBe(true);
      expect(config2.mCases.has(200)).toBe(true);
      expect(config2.mCases.has(300)).toBe(true);
    });

    it('should use different subdomains based on hash and config', async () => {
      const info = await fetchGalleryInfo(12345);
      const file = info.files[0];

      const config1 = parseGgJs(mockGgJsV1);
      const url1 = getImageUrl(file, config1);

      const config2 = parseGgJs(mockGgJsV2);
      const url2 = getImageUrl(file, config2);

      // Extract subdomain from URLs
      const extractSubdomain = (url: string) => {
        const match = /^\/api\/img\/([a-z]\d+)\//.exec(url);
        return match ? match[1] : null;
      };

      const subdomain1 = extractSubdomain(url1);
      const subdomain2 = extractSubdomain(url2);

      // Subdomains might be different based on hash code and config
      expect(subdomain1).toMatch(/^a[12]$/); // Both use 'a' prefix for avif
      expect(subdomain2).toMatch(/^a[12]$/);

      // The suffix (1 or 2) might differ based on mDefault and mCases
      // This verifies the dynamic configuration is actually used
      expect(config1.mDefault).not.toBe(config2.mDefault);
    });
  });

  describe('7. End-to-End Gallery Workflow', () => {
    it('should complete full workflow: fetch → parse → convert → generate URLs', async () => {
      // Step 1: Fetch gallery info
      const info = await fetchGalleryInfo(12345);
      expect(info.id).toBe(12345);
      expect(info.files).toHaveLength(3);

      // Step 2: Convert to block
      const block = galleryInfoToBlock(info);
      expect(block.type).toBe(GalleryBlockType.DETAILED);
      expect(block.thumbnail).toContain('/api/img/tn/');

      // Step 3: Convert to images
      const images = galleryInfoToImages(info);
      expect(images.images).toHaveLength(3);

      // Step 4: Generate URLs for all images
      const config = await getGgConfig();
      for (let i = 0; i < info.files.length; i++) {
        const file = info.files[i];
        const imageUrl = getImageUrl(file, config);
        const thumbUrl = getThumbnailUrl(file);

        // Verify all URLs go through proxy
        expect(imageUrl).toMatch(/^\/api\/img\//);
        expect(thumbUrl).toMatch(/^\/api\/img\/tn\//);

        // Verify URL contains hash
        expect(imageUrl).toContain(file.hash);
        expect(thumbUrl).toContain(file.hash);
      }

      // Verify fetch was called for gg.js and gallery JSON
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/hitomi/gg.js'),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/hitomi/galleries/12345.js'),
        expect.any(Object)
      );
    });
  });
});
