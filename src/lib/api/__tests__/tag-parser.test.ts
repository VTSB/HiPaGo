import { describe, it, expect } from 'vitest';
import { parseTagsFromHtml, parseNavUrls, TAG_TYPES } from '../tag-parser';

describe('TAG_TYPES', () => {
  it('has 5 entries with correct types', () => {
    expect(TAG_TYPES).toHaveLength(5);
    expect(TAG_TYPES.map(t => t.urlType)).toEqual(['artists', 'series', 'characters', 'groups', 'tags']);
    expect(TAG_TYPES.map(t => t.defaultType)).toEqual(['artist', 'series', 'character', 'group', 'tag']);
  });
});

describe('parseTagsFromHtml', () => {
  it('parses basic tag entries', () => {
    const html = `
      <div class="content"><ul>
        <li><a href="/tag/action-all.html">action</a> (5,000)</li>
        <li><a href="/tag/comedy-all.html">comedy</a> (3,000)</li>
      </ul></div>
    `;
    const tags = parseTagsFromHtml(html, 'tag');
    expect(tags).toHaveLength(2);
    expect(tags[0]).toEqual({ name: 'action', count: 5000, type: 'tag' });
    expect(tags[1]).toEqual({ name: 'comedy', count: 3000, type: 'tag' });
  });

  it('detects female tags from href', () => {
    const html = `
      <div class="content"><ul>
        <li><a href="/tag/female:loli-all.html">loli ♀</a> (8,000)</li>
      </ul></div>
    `;
    const tags = parseTagsFromHtml(html, 'tag');
    expect(tags).toHaveLength(1);
    expect(tags[0].type).toBe('female');
    expect(tags[0].name).toBe('loli');
  });

  it('detects male tags from href', () => {
    const html = `
      <div class="content"><ul>
        <li><a href="/tag/male:muscle-all.html">muscle ♂</a> (3,000)</li>
      </ul></div>
    `;
    const tags = parseTagsFromHtml(html, 'tag');
    expect(tags[0].type).toBe('male');
    expect(tags[0].name).toBe('muscle');
  });

  it('detects female by ♀ suffix when href has no prefix', () => {
    const html = `
      <div class="content"><ul>
        <li><a href="/tag/loli-all.html">loli♀</a> (8,000)</li>
      </ul></div>
    `;
    const tags = parseTagsFromHtml(html, 'tag');
    expect(tags[0].type).toBe('female');
    expect(tags[0].name).toBe('loli');
  });

  it('detects male by ♂ suffix when href has no prefix', () => {
    const html = `
      <div class="content"><ul>
        <li><a href="/tag/muscle-all.html">muscle♂</a> (3,000)</li>
      </ul></div>
    `;
    const tags = parseTagsFromHtml(html, 'tag');
    expect(tags[0].type).toBe('male');
    expect(tags[0].name).toBe('muscle');
  });

  it('returns empty for HTML with no content block', () => {
    expect(parseTagsFromHtml('<html><body>hello</body></html>', 'tag')).toEqual([]);
  });

  it('returns empty for content block with no tags', () => {
    const html = '<div class="content"><ul><li>no links here</li></ul></div>';
    expect(parseTagsFromHtml(html, 'tag')).toEqual([]);
  });

  it('skips entries with empty names', () => {
    const html = `
      <div class="content"><ul>
        <li><a href="/tag/a-all.html"><span></span></a> (100)</li>
      </ul></div>
    `;
    expect(parseTagsFromHtml(html, 'tag')).toEqual([]);
  });

  it('strips HTML tags from names', () => {
    const html = `
      <div class="content"><ul>
        <li><a href="/artist/test-all.html"><span class="x">test artist</span></a> (500)</li>
      </ul></div>
    `;
    const tags = parseTagsFromHtml(html, 'artist');
    expect(tags[0].name).toBe('test artist');
  });

  it('handles HTML entities in href', () => {
    const html = `
      <div class="content"><ul>
        <li><a href="/tag/female:big+breasts-all.html">big breasts ♀</a> (120,000)</li>
      </ul></div>
    `;
    const tags = parseTagsFromHtml(html, 'tag');
    expect(tags[0].count).toBe(120000);
  });

  it('handles counts with commas', () => {
    const html = `
      <div class="content"><ul>
        <li><a href="/artist/a-all.html">test</a> (1,234,567)</li>
      </ul></div>
    `;
    const tags = parseTagsFromHtml(html, 'artist');
    expect(tags[0].count).toBe(1234567);
  });
});

describe('parseNavUrls', () => {
  it('extracts navigation URLs', () => {
    const html = `
      <div class="page-content"><ul>
        <li><a href="/allartists-a.html">A</a></li>
        <li><a href="/allartists-b.html">B</a></li>
        <li><a href="/allartists-c.html">C</a></li>
      </ul>
    `;
    const urls = parseNavUrls(html);
    expect(urls).toEqual(['allartists-a.html', 'allartists-b.html', 'allartists-c.html']);
  });

  it('deduplicates URLs', () => {
    const html = `
      <div class="page-content"><ul>
        <li><a href="/allartists-a.html">A</a></li>
        <li><a href="/allartists-a.html">A</a></li>
        <li><a href="/allartists-b.html">B</a></li>
      </ul>
    `;
    const urls = parseNavUrls(html);
    expect(urls).toEqual(['allartists-a.html', 'allartists-b.html']);
  });

  it('returns empty when no nav block', () => {
    expect(parseNavUrls('<html><body></body></html>')).toEqual([]);
  });

  it('strips leading slashes from hrefs', () => {
    const html = `
      <div class="page-content"><ul>
        <li><a href="/alltags-a.html">A</a></li>
      </ul>
    `;
    const urls = parseNavUrls(html);
    expect(urls[0]).toBe('alltags-a.html');
  });
});
