/**
 * DOM-dependent parser tests
 *
 * NOTE: These tests require jsdom environment but jsdom v28 has known hanging issues
 * in some environments. The test file is structured correctly but may timeout during
 * execution due to jsdom initialization problems.
 *
 * To run these tests when jsdom is working:
 * 1. Ensure jsdom v28.1.0 is properly installed
 * 2. Run: npm test -- parser-dom.test.ts
 *
 * Alternative: Manually test the functions by running the application and verifying:
 * - parseGalleryBlockHtml correctly parses gallery HTML from hitomi.la
 * - parseTagListHtml correctly parses tag list HTML
 */

import { describe, it, expect } from 'vitest';
import { parseGalleryBlockHtml, galleryInfoToBlock } from '../parser';
import { GalleryBlockType, TagType } from '@/lib/utils/types';
import type { GalleryInfo } from '@/lib/utils/types';

/** Minimal element shape used in the mock DOM rows */
interface MockElement {
  querySelector(sel: string): { textContent: string } | null;
  querySelectorAll(sel: string): Array<{ textContent: string }>;
}

/** Minimal text-node shape */
interface MockTextNode {
  textContent: string;
}

// Mock DOMParser for testing without full jsdom environment
class MockDOMParser {
  parseFromString(html: string): Document {
    // This is a simplified mock - real tests would use jsdom
    const doc = {
      querySelector: (selector: string) => {
        // Handle comma-separated selectors
        if (selector === '.lillie a, h1 a') {
          if (html.includes('class="lillie"')) {
            return { textContent: 'Test Gallery Title' };
          }
          if (html.includes('<h1>')) {
            return { textContent: 'Test Gallery Title' };
          }
        }
        if (selector === '.lillie a' && html.includes('class="lillie"')) {
          return { textContent: 'Test Gallery Title' };
        }
        if (selector === 'h1 a' && html.includes('<h1>')) {
          return { textContent: 'Test Gallery Title' };
        }
        if (selector === '.date' && html.includes('class="date"')) {
          return { textContent: '2024-01-15 12:30' };
        }
        if (selector === 'img' && html.includes('<img')) {
          return {
            getAttribute: (attr: string) => {
              if (attr === 'data-src' && html.includes('data-src=')) {
                const match = /data-src="([^"]+)"/.exec(html);
                return match ? match[1] : null;
              }
              if (attr === 'src' && html.includes('src=')) {
                const match = /src="([^"]+)"/.exec(html);
                return match ? match[1] : null;
              }
              return null;
            },
          };
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector === 'tr') {
          // Parse table rows from HTML (ES2017-compatible regex)
          const rows: MockElement[] = [];
          const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
          let trMatch;
          while ((trMatch = trRegex.exec(html)) !== null) {
            const rowHtml = trMatch[1];
            const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
            const tdMatches: RegExpExecArray[] = [];
            let tdMatch;
            while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
              tdMatches.push(tdMatch);
            }
            if (tdMatches.length >= 2) {
              const header = tdMatches[0][1].replace(/<[^>]+>/g, '').trim();
              const links: MockTextNode[] = [];
              const linkRegex = /<a[^>]*>([^<]+)<\/a>/g;
              let linkMatch;
              while ((linkMatch = linkRegex.exec(tdMatches[1][1])) !== null) {
                links.push({ textContent: linkMatch[1].trim() });
              }
              rows.push({
                querySelector: (sel: string) =>
                  sel === 'td:first-child' ? { textContent: header } : null,
                querySelectorAll: (sel: string) =>
                  sel === 'td:last-child a' ? links : [],
              });
            }
          }
          return rows;
        }
        if (selector === 'script') {
          const scripts: MockTextNode[] = [];
          const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/g;
          let scriptMatch;
          while ((scriptMatch = scriptRegex.exec(html)) !== null) {
            scripts.push({ textContent: scriptMatch[1] });
          }
          return scripts;
        }
        if (selector === 'a') {
          const links: Array<{ textContent: string; nextSibling: MockTextNode }> = [];
          const linkRegex = /<a[^>]*>([^<]+)<\/a>\s*(?:\((\d+)\))?/g;
          let linkMatch;
          while ((linkMatch = linkRegex.exec(html)) !== null) {
            const nextText = linkMatch[2] ? `(${linkMatch[2]})` : '';
            links.push({
              textContent: linkMatch[1].trim(),
              nextSibling: { textContent: nextText },
            });
          }
          return links;
        }
        return [];
      },
    } as unknown as Document;
    return doc;
  }
}

// Install mock
if (typeof DOMParser === 'undefined') {
  global.DOMParser = MockDOMParser as unknown as typeof DOMParser;
}

describe('parseGalleryBlockHtml', () => {
  it('parses title from .lillie a element', () => {
    const html = `
      <div>
        <div class="lillie"><a href="/gallery/12345.html">Test Gallery Title</a></div>
      </div>
    `;
    const result = parseGalleryBlockHtml(html, 12345);
    expect(result.title).toBe('Test Gallery Title');
  });

  it('parses date from .date element', () => {
    const html = `
      <div>
        <div class="date">2024-01-15 12:30</div>
      </div>
    `;
    const result = parseGalleryBlockHtml(html, 12345);
    expect(result.date).toBeInstanceOf(Date);
    expect(result.date.getFullYear()).toBe(2024);
  });

  it('extracts thumbnail from img data-src attribute', () => {
    const html = `
      <div>
        <img data-src="//tn.hitomi.la/avifsmalltn/a/bc/abcdef1234.avif" />
      </div>
    `;
    const result = parseGalleryBlockHtml(html, 12345);
    expect(result.thumbnail).toBe('/api/img/tn/avifsmalltn/a/bc/abcdef1234.avif');
  });

  it('rewrites hitomi.la thumbnails to proxy', () => {
    const html = `
      <div>
        <img data-src="https://tn.hitomi.la/webpsmalltn/test.webp" />
      </div>
    `;
    const result = parseGalleryBlockHtml(html, 12345);
    expect(result.thumbnail).toBe('/api/img/tn/webpsmalltn/test.webp');
  });

  it('parses artist tags from table rows', () => {
    const html = `
      <table>
        <tr>
          <td>Artist</td>
          <td><a href="/artist/test-all.html">testartist</a></td>
        </tr>
      </table>
    `;
    const result = parseGalleryBlockHtml(html, 12345);
    expect(result.tags[TagType.ARTIST]).toEqual(['testartist']);
  });

  it('parses multiple tag types', () => {
    const html = `
      <table>
        <tr><td>Tags</td><td><a>tag1</a><a>tag2</a></td></tr>
        <tr><td>Series</td><td><a>testseries</a></td></tr>
      </table>
    `;
    const result = parseGalleryBlockHtml(html, 12345);
    expect(result.tags[TagType.TAG]).toEqual(['tag1', 'tag2']);
    expect(result.tags[TagType.SERIES]).toEqual(['testseries']);
  });

  it('extracts related IDs from script tags', () => {
    const html = `
      <div>
        <script>var related = [111, 222, 333];</script>
      </div>
    `;
    const result = parseGalleryBlockHtml(html, 12345);
    expect(result.related).toEqual([111, 222, 333]);
  });

  it('returns GalleryBlockType.NOT_DETAILED type', () => {
    const html = '<div></div>';
    const result = parseGalleryBlockHtml(html, 12345);
    expect(result.type).toBe(GalleryBlockType.NOT_DETAILED);
  });

  it('handles missing elements gracefully', () => {
    const html = '<div></div>';
    const result = parseGalleryBlockHtml(html, 12345);
    expect(result.title).toBe('');
    expect(result.thumbnail).toBe('');
    expect(result.date).toBeInstanceOf(Date);
    expect(result.tags).toEqual({});
  });

  it('detects ♂ suffix in tag text and categorizes as MALE', () => {
    const html = `
      <table>
        <tr>
          <td>Tags</td>
          <td><a>shotacon ♂</a></td>
        </tr>
      </table>
    `;
    const result = parseGalleryBlockHtml(html, 12345);
    expect(result.tags[TagType.MALE]).toEqual(['shotacon']);
    expect(result.tags[TagType.TAG]).toBeUndefined();
  });

  it('detects ♀ suffix in tag text and categorizes as FEMALE', () => {
    const html = `
      <table>
        <tr>
          <td>Tags</td>
          <td><a>loli ♀</a></td>
        </tr>
      </table>
    `;
    const result = parseGalleryBlockHtml(html, 12345);
    expect(result.tags[TagType.FEMALE]).toEqual(['loli']);
    expect(result.tags[TagType.TAG]).toBeUndefined();
  });

  it('does not strip ♂/♀ from non-TAG rows', () => {
    // A tag row with artist header should not reclassify based on suffix
    const html = `
      <table>
        <tr>
          <td>Artist</td>
          <td><a>artist-name</a></td>
        </tr>
      </table>
    `;
    const result = parseGalleryBlockHtml(html, 12345);
    expect(result.tags[TagType.ARTIST]).toEqual(['artist-name']);
  });

  it('passes through a non-hitomi thumbnail URL unchanged', () => {
    const html = `
      <div>
        <img data-src="https://example.com/images/thumb.jpg" />
      </div>
    `;
    const result = parseGalleryBlockHtml(html, 12345);
    expect(result.thumbnail).toBe('https://example.com/images/thumb.jpg');
  });
});

describe('galleryInfoToBlock — top-level artist/group/character/parody merging', () => {
  const makeInfo = (overrides: Partial<GalleryInfo>): GalleryInfo => ({
    id: 1,
    title: 'Title',
    japaneseTitle: '',
    language: 'english',
    languageLocalName: 'English',
    date: '2025-01-01 00:00',
    type: 'manga',
    files: [],
    tags: [],
    artists: [],
    groups: [],
    characters: [],
    parodys: [],
    related: [],
    ...overrides,
  });

  it('merges top-level artists into ARTIST tag bucket', () => {
    const info = makeInfo({ artists: ['artist-alpha', 'artist-beta'] });
    const block = galleryInfoToBlock(info);
    expect(block.tags[TagType.ARTIST]).toEqual(['artist-alpha', 'artist-beta']);
  });

  it('merges top-level groups into GROUP tag bucket', () => {
    const info = makeInfo({ groups: ['group-one'] });
    const block = galleryInfoToBlock(info);
    expect(block.tags[TagType.GROUP]).toEqual(['group-one']);
  });

  it('merges top-level characters into CHARACTER tag bucket', () => {
    const info = makeInfo({ characters: ['char-x', 'char-y'] });
    const block = galleryInfoToBlock(info);
    expect(block.tags[TagType.CHARACTER]).toEqual(['char-x', 'char-y']);
  });

  it('merges top-level parodys into SERIES tag bucket', () => {
    const info = makeInfo({ parodys: ['parody-one'] });
    const block = galleryInfoToBlock(info);
    expect(block.tags[TagType.SERIES]).toEqual(['parody-one']);
  });

  it('deduplicates artists already present in tags', () => {
    // Tag-derived artist via tags array + top-level artists overlap
    const info = makeInfo({
      tags: [{ male: '0', female: '0', url: 'artist/existing-all.html', tag: 'existing-artist' }],
      artists: ['existing-artist', 'new-artist'],
    });
    const block = galleryInfoToBlock(info);
    // 'existing-artist' must appear only once
    expect(block.tags[TagType.ARTIST]).toEqual(['existing-artist', 'new-artist']);
    const artistCount = block.tags[TagType.ARTIST]!.filter(a => a === 'existing-artist').length;
    expect(artistCount).toBe(1);
  });

  it('deduplicates groups already present in tags', () => {
    const info = makeInfo({
      tags: [{ male: '0', female: '0', url: 'group/shared-all.html', tag: 'shared-group' }],
      groups: ['shared-group', 'extra-group'],
    });
    const block = galleryInfoToBlock(info);
    expect(block.tags[TagType.GROUP]).toEqual(['shared-group', 'extra-group']);
    const count = block.tags[TagType.GROUP]!.filter(g => g === 'shared-group').length;
    expect(count).toBe(1);
  });

  it('deduplicates series (parodys) already present in tags', () => {
    const info = makeInfo({
      tags: [{ male: '0', female: '0', url: 'series/same-all.html', tag: 'same-series' }],
      parodys: ['same-series', 'another-series'],
    });
    const block = galleryInfoToBlock(info);
    expect(block.tags[TagType.SERIES]).toEqual(['same-series', 'another-series']);
    const count = block.tags[TagType.SERIES]!.filter(s => s === 'same-series').length;
    expect(count).toBe(1);
  });

  it('leaves tag buckets absent when no top-level fields and no tag entries', () => {
    const info = makeInfo({});
    const block = galleryInfoToBlock(info);
    expect(block.tags[TagType.ARTIST]).toBeUndefined();
    expect(block.tags[TagType.GROUP]).toBeUndefined();
    expect(block.tags[TagType.CHARACTER]).toBeUndefined();
    expect(block.tags[TagType.SERIES]).toBeUndefined();
  });
});
