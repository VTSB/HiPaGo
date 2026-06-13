// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  parseGgJs,
  imageHashCode,
  getImageUrl,
  getThumbnailUrl,
  getBestImageUrl,
  ggM,
  galleryImageToFile,
} from '../image-url';
import type { GalleryFile, GalleryImage, GgConfig } from '../types';
import { ImageType } from '../types';

function makeFile(overrides: Partial<GalleryFile> = {}): GalleryFile {
  return {
    width: 800,
    height: 600,
    haswebp: 0,
    hasavifsmalltn: 0,
    hasavif: 0,
    name: 'test.jpg',
    hash: 'abc1234567890abcdef1234567890abcdef12345678901234567890abcdef1234',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<GgConfig> = {}): GgConfig {
  return {
    pathCode: 'gg',
    mDefault: 1,
    mCases: new Set(),
    mCaseValue: 0,
    ...overrides,
  };
}

describe('parseGgJs', () => {
  it('parses new gg.js object format', () => {
    const text = `var gg = {};
gg = {
  m: function(g) {
    var o = 1;
    switch(g) {
      case 42:
      case 100:
      case 255:
        o = 0;
        break;
    }
    return o;
  },
  s: function(h) { return ''; },
  b: '1771491602/'
};`;
    const config = parseGgJs(text);
    expect(config.pathCode).toBe('1771491602');
    expect(config.mDefault).toBe(1);
    expect(config.mCaseValue).toBe(0);
    expect(config.mCases.has(42)).toBe(true);
    expect(config.mCases.has(100)).toBe(true);
    expect(config.mCases.has(255)).toBe(true);
    expect(config.mCases.size).toBe(3);
  });

  it('parses old format with var b and var o', () => {
    const text = "var b = '1719741324/';\nvar o = 1;\ncase 42:\ncase 100:\n";
    const config = parseGgJs(text);
    expect(config.pathCode).toBe('1719741324');
    expect(config.mDefault).toBe(1);
    expect(config.mCases.has(42)).toBe(true);
    expect(config.mCases.has(100)).toBe(true);
  });

  it('parses default o=0 with case value 1', () => {
    const text = `var o = 0;
switch(g) { case 10: o = 1; break; }
b: 'test/'`;
    const config = parseGgJs(text);
    expect(config.mDefault).toBe(0);
    expect(config.mCaseValue).toBe(1);
    expect(config.mCases.has(10)).toBe(true);
  });

  it('defaults to pathCode "" and mDefault 1', () => {
    const config = parseGgJs('');
    expect(config.pathCode).toBe('');
    expect(config.mDefault).toBe(1);
    expect(config.mCases.size).toBe(0);
  });
});

describe('ggM', () => {
  it('returns mCaseValue when hashCode is in mCases', () => {
    const config = makeConfig({ mDefault: 1, mCaseValue: 0, mCases: new Set([42]) });
    expect(ggM(42, config)).toBe(0);
  });

  it('returns mDefault when hashCode is NOT in mCases', () => {
    const config = makeConfig({ mDefault: 1, mCaseValue: 0, mCases: new Set([42]) });
    expect(ggM(99, config)).toBe(1);
  });
});

describe('imageHashCode', () => {
  it('computes hash code from last 3 hex chars', () => {
    // hash ending in '234' → slice(-1)='4', slice(-3,-1)='23' → parseInt('423', 16) = 1059
    expect(imageHashCode('abc1234567890abcdef1234567890abcdef12345678901234567890abcdef1234')).toBe(
      parseInt('423', 16),
    );
  });

  it('handles short hashes', () => {
    // 'abc' → slice(-1)='c', slice(-3,-1)='ab' → parseInt('cab', 16) = 3243
    expect(imageHashCode('abc')).toBe(parseInt('cab', 16));
  });
});

describe('getImageUrl', () => {
  it('constructs avif URL: subdomain=a(1+m), no dir prefix', () => {
    const file = makeFile({ hasavif: 1, haswebp: 1, hash: 'abcdef1234' });
    const config = makeConfig({ pathCode: 'gg' });
    const url = getImageUrl(file, config);
    expect(url).toMatch(/^\/api\/img\/a[12]\/gg\//);
    expect(url).toContain('.avif');
    expect(url).not.toContain('/avif/');
  });

  it('constructs webp URL: subdomain=w(1+m), no dir prefix', () => {
    const file = makeFile({ hasavif: 0, haswebp: 1, hash: 'abcdef1234' });
    const config = makeConfig({ pathCode: 'gg' });
    const url = getImageUrl(file, config);
    expect(url).toMatch(/^\/api\/img\/w[12]\/gg\//);
    expect(url).toContain('.webp');
    expect(url).not.toContain('/webp/');
  });

  it('constructs original URL: subdomain=(1+m), images/ dir prefix', () => {
    const file = makeFile({ hasavif: 0, haswebp: 0, name: 'photo.jpg', hash: 'abcdef1234' });
    const config = makeConfig({ pathCode: 'gg' });
    const url = getImageUrl(file, config);
    expect(url).toMatch(/^\/api\/img\/[12]\/images\/gg\//);
    expect(url).toContain('.jpg');
  });

  it('includes pathCode and imageHashCode in path', () => {
    const hash = 'abc123';
    const file = makeFile({ hasavif: 1, hash });
    const config = makeConfig({ pathCode: 'testpath' });
    const url = getImageUrl(file, config);
    const expectedHashCode = parseInt(hash.slice(-1) + hash.slice(-3, -1), 16);
    expect(url).toContain(`/testpath/${expectedHashCode}/${hash}.avif`);
  });

  it('uses correct subdomain based on gg config', () => {
    const hash = 'abc123';
    const hashCode = parseInt(hash.slice(-1) + hash.slice(-3, -1), 16);
    const file = makeFile({ hasavif: 1, hash });
    // mDefault=1, mCaseValue=0, hashCode IS in mCases → m=0 → subdomain = 'a' + (1+0) = 'a1'
    const config = makeConfig({ pathCode: 'gg', mDefault: 1, mCaseValue: 0, mCases: new Set([hashCode]) });
    const url = getImageUrl(file, config);
    expect(url).toMatch(/^\/api\/img\/a1\//);
  });

  it('uses subdomain a2 when hashCode not in mCases (default m=1)', () => {
    const hash = 'abc123';
    const file = makeFile({ hasavif: 1, hash });
    const config = makeConfig({ pathCode: 'gg', mDefault: 1, mCaseValue: 0, mCases: new Set() });
    const url = getImageUrl(file, config);
    expect(url).toMatch(/^\/api\/img\/a2\//);
  });
});

describe('getThumbnailUrl', () => {
  it('uses tn subdomain (proxy resolves to atn/btn)', () => {
    const file = makeFile({ hasavifsmalltn: 1, hash: 'abcdef1234' });
    const url = getThumbnailUrl(file);
    expect(url).toMatch(/^\/api\/img\/tn\//);
  });

  it('uses avifsmalltn when available', () => {
    const file = makeFile({ hasavifsmalltn: 1, hash: 'abcdef1234' });
    const url = getThumbnailUrl(file);
    expect(url).toContain('/avifsmalltn/');
    expect(url).toContain('.avif');
  });

  it('uses webpsmalltn when no avif tn', () => {
    const file = makeFile({ hasavifsmalltn: 0, haswebp: 1, hash: 'abcdef1234' });
    const url = getThumbnailUrl(file);
    expect(url).toContain('/webpsmalltn/');
    expect(url).toContain('.webp');
  });

  it('uses original ext as fallback', () => {
    const file = makeFile({ hasavifsmalltn: 0, haswebp: 0, name: 'img.png', hash: 'abcdef1234' });
    const url = getThumbnailUrl(file);
    expect(url).toContain('/smalltn/');
    expect(url).toContain('.png');
  });

  it('constructs correct hash path in thumbnail', () => {
    const hash = 'abcdef1234';
    const file = makeFile({ hasavifsmalltn: 1, hash });
    const url = getThumbnailUrl(file);
    // hashPath = hash[-1]/hash[-3:-1]/hash = 4/23/abcdef1234
    expect(url).toContain(`/4/23/${hash}`);
  });

  it('supports big size', () => {
    const file = makeFile({ hasavifsmalltn: 0, hasavif: 1, hash: 'abcdef1234' });
    const url = getThumbnailUrl(file, 'big');
    expect(url).toContain('/avifbigtn/');
  });
});

describe('getBestImageUrl', () => {
  it('delegates to getImageUrl', () => {
    const file = makeFile({ hasavif: 1 });
    const config = makeConfig();
    const url = getBestImageUrl(file, config);
    expect(url).toContain('.avif');
  });
});

describe('getImageUrl preferredFormat', () => {
  it("'original' forces original extension regardless of hasavif/haswebp", () => {
    const file = makeFile({ hasavif: 1, haswebp: 1, name: 'photo.jpg', hash: 'abcdef1234' });
    const config = makeConfig();
    const url = getImageUrl(file, config, 'original');
    expect(url).toContain('/images/');
    expect(url).toContain('.jpg');
    expect(url).not.toContain('.avif');
    expect(url).not.toContain('.webp');
  });

  it("'webp' uses webp when haswebp (no dir prefix)", () => {
    const file = makeFile({ hasavif: 1, haswebp: 1, name: 'photo.jpg', hash: 'abcdef1234' });
    const config = makeConfig();
    const url = getImageUrl(file, config, 'webp');
    expect(url).not.toContain('/webp/');
    expect(url).toContain('.webp');
  });

  it("'webp' falls back to original when no haswebp", () => {
    const file = makeFile({ hasavif: 1, haswebp: 0, name: 'photo.jpg', hash: 'abcdef1234' });
    const config = makeConfig();
    const url = getImageUrl(file, config, 'webp');
    expect(url).toContain('/images/');
    expect(url).toContain('.jpg');
  });

  it("'webp' treats a .webp source file as webp even when haswebp=0", () => {
    const file = makeFile({ hasavif: 0, haswebp: 0, name: 'source.webp', hash: 'abcdef1234' });
    const config = makeConfig();
    const url = getImageUrl(file, config, 'webp');
    expect(url).toMatch(/^\/api\/img\/w[12]\//);
    expect(url).not.toContain('/images/');
    expect(url).toContain('.webp');
  });

  it("'avif' uses avif when hasavif (no dir prefix)", () => {
    const file = makeFile({ hasavif: 1, haswebp: 1, name: 'photo.jpg', hash: 'abcdef1234' });
    const config = makeConfig();
    const url = getImageUrl(file, config, 'avif');
    expect(url).not.toContain('/avif/');
    expect(url).toContain('.avif');
  });

  it("'avif' falls back to webp when no hasavif but haswebp", () => {
    const file = makeFile({ hasavif: 0, haswebp: 1, name: 'photo.jpg', hash: 'abcdef1234' });
    const config = makeConfig();
    const url = getImageUrl(file, config, 'avif');
    expect(url).not.toContain('/webp/');
    expect(url).toContain('.webp');
  });

  it("'avif' falls back to original when no avif or webp", () => {
    const file = makeFile({ hasavif: 0, haswebp: 0, name: 'photo.jpg', hash: 'abcdef1234' });
    const config = makeConfig();
    const url = getImageUrl(file, config, 'avif');
    expect(url).toContain('/images/');
    expect(url).toContain('.jpg');
  });

  it("'avif' treats a .avif source file as avif even when hasavif=0", () => {
    const file = makeFile({ hasavif: 0, haswebp: 0, name: 'source.avif', hash: 'abcdef1234' });
    const config = makeConfig();
    const url = getImageUrl(file, config, 'avif');
    expect(url).toMatch(/^\/api\/img\/a[12]\//);
    expect(url).not.toContain('/images/');
    expect(url).toContain('.avif');
  });

  it("'auto' behaves like default (avif > webp > original)", () => {
    const fileAvif = makeFile({ hasavif: 1, haswebp: 1, hash: 'abcdef1234' });
    expect(getImageUrl(fileAvif, makeConfig(), 'auto')).toContain('.avif');

    const fileWebp = makeFile({ hasavif: 0, haswebp: 1, hash: 'abcdef1234' });
    expect(getImageUrl(fileWebp, makeConfig(), 'auto')).toContain('.webp');

    const fileOrig = makeFile({ hasavif: 0, haswebp: 0, name: 'x.png', hash: 'abcdef1234' });
    expect(getImageUrl(fileOrig, makeConfig(), 'auto')).toContain('.png');
  });

  it("'auto' routes .webp source files through the webp CDN host", () => {
    const file = makeFile({ hasavif: 0, haswebp: 0, name: 'x.webp', hash: 'abcdef1234' });
    const url = getImageUrl(file, makeConfig(), 'auto');
    expect(url).toMatch(/^\/api\/img\/w[12]\//);
    expect(url).not.toContain('/images/');
  });

  it("'original' routes .webp source files through the webp CDN host", () => {
    const file = makeFile({ hasavif: 0, haswebp: 0, name: 'x.webp', hash: 'abcdef1234' });
    const url = getImageUrl(file, makeConfig(), 'original');
    expect(url).toMatch(/^\/api\/img\/w[12]\//);
    expect(url).not.toContain('/images/');
  });

  it('undefined preferredFormat behaves like default (avif > webp > original)', () => {
    const fileAvif = makeFile({ hasavif: 1, haswebp: 1, hash: 'abcdef1234' });
    expect(getImageUrl(fileAvif, makeConfig(), undefined)).toContain('.avif');

    const fileWebp = makeFile({ hasavif: 0, haswebp: 1, hash: 'abcdef1234' });
    expect(getImageUrl(fileWebp, makeConfig(), undefined)).toContain('.webp');

    const fileOrig = makeFile({ hasavif: 0, haswebp: 0, name: 'x.png', hash: 'abcdef1234' });
    expect(getImageUrl(fileOrig, makeConfig(), undefined)).toContain('.png');
  });
});

describe('getImageUrl edge cases', () => {
  it("'original' falls back to 'jpg' when name ends with a dot (empty ext)", () => {
    const file = makeFile({ hasavif: 0, haswebp: 0, name: 'file.', hash: 'abcdef1234' });
    const url = getImageUrl(file, makeConfig(), 'original');
    expect(url).toContain('.jpg');
  });

  it("'webp' falls back to 'jpg' ext when no haswebp and name ends with a dot", () => {
    const file = makeFile({ hasavif: 0, haswebp: 0, name: 'file.', hash: 'abcdef1234' });
    const url = getImageUrl(file, makeConfig(), 'webp');
    expect(url).toContain('.jpg');
    expect(url).toContain('/images/');
  });

  it("'avif' falls back to 'jpg' ext when no avif/webp and name ends with a dot", () => {
    const file = makeFile({ hasavif: 0, haswebp: 0, name: 'file.', hash: 'abcdef1234' });
    const url = getImageUrl(file, makeConfig(), 'avif');
    expect(url).toContain('.jpg');
    expect(url).toContain('/images/');
  });

  it("auto/undefined falls back to 'jpg' ext when no avif/webp and name ends with a dot", () => {
    const file = makeFile({ hasavif: 0, haswebp: 0, name: 'file.', hash: 'abcdef1234' });
    const url = getImageUrl(file, makeConfig());
    expect(url).toContain('.jpg');
    expect(url).toContain('/images/');
  });
});

describe('getThumbnailUrl edge cases', () => {
  it("falls back to 'jpg' when name ends with a dot (empty ext)", () => {
    const file = makeFile({ hasavifsmalltn: 0, hasavif: 0, haswebp: 0, name: 'file.', hash: 'abcdef1234' });
    const url = getThumbnailUrl(file);
    expect(url).toContain('.jpg');
  });
});

describe('galleryImageToFile', () => {
  function makeImage(overrides: Partial<GalleryImage> = {}): GalleryImage {
    return {
      name: 'img.jpg',
      hash: 'abc123',
      width: 1280,
      height: 720,
      types: new Set(),
      ...overrides,
    };
  }

  it('converts GalleryImage with WEBP+AVIF types to haswebp=1, hasavif=1', () => {
    const image = makeImage({ types: new Set([ImageType.WEBP, ImageType.AVIF]) });
    const file = galleryImageToFile(image);
    expect(file.haswebp).toBe(1);
    expect(file.hasavif).toBe(1);
  });

  it('converts GalleryImage with only ORIGINAL to haswebp=0, hasavif=0', () => {
    const image = makeImage({ types: new Set([ImageType.ORIGINAL]) });
    const file = galleryImageToFile(image);
    expect(file.haswebp).toBe(0);
    expect(file.hasavif).toBe(0);
  });

  it('sets hasavifsmalltn=1 when AVIFSMALLTN type is present', () => {
    const image = makeImage({ types: new Set([ImageType.AVIFSMALLTN]) });
    expect(galleryImageToFile(image).hasavifsmalltn).toBe(1);
  });

  it('sets hasavifsmalltn=0 when AVIFSMALLTN type is absent', () => {
    const image = makeImage({ types: new Set([ImageType.WEBP, ImageType.AVIF]) });
    expect(galleryImageToFile(image).hasavifsmalltn).toBe(0);

    const image2 = makeImage({ types: new Set() });
    expect(galleryImageToFile(image2).hasavifsmalltn).toBe(0);
  });

  it('preserves name, hash, width, height from source image', () => {
    const image = makeImage({ name: 'photo.png', hash: 'deadbeef', width: 800, height: 600, types: new Set() });
    const file = galleryImageToFile(image);
    expect(file.name).toBe('photo.png');
    expect(file.hash).toBe('deadbeef');
    expect(file.width).toBe(800);
    expect(file.height).toBe(600);
  });
});
