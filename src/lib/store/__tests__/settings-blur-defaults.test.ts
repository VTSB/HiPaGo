import { describe, it, expect } from 'vitest';
import { migrateSettings, DEFAULT_BLUR_TAGS } from '../settings';

const SAFETY = [
  'female:furry',
  'male:furry',
  'female:snuff',
  'male:snuff',
  'female:guro',
  'male:guro',
  'female:scat',
  'male:scat',
];

describe('default blur tags + v1 migration', () => {
  it('default blurTags includes male:yaoi plus the gendered safety tags', () => {
    expect(DEFAULT_BLUR_TAGS).toEqual(['male:yaoi', ...SAFETY]);
  });

  it('migrates a v0 user: unions the safety tags, preserves other state', () => {
    const out = migrateSettings({ blurTags: ['male:yaoi'], theme: 'dark' }, 0) as {
      blurTags: string[];
      theme: string;
    };
    expect(out.blurTags).toEqual(['male:yaoi', ...SAFETY]);
    expect(out.theme).toBe('dark');
  });

  it('does not duplicate a tag the user already had', () => {
    const out = migrateSettings({ blurTags: ['female:guro', 'male:yaoi'] }, 0) as { blurTags: string[] };
    expect(out.blurTags.filter((t) => t === 'female:guro')).toHaveLength(1);
    expect(out.blurTags).toEqual(expect.arrayContaining(['male:yaoi', ...SAFETY]));
  });

  it('is a no-op at version >= 2 (a later user removal stays removed)', () => {
    const state = { blurTags: ['male:yaoi'], imageCacheMaxBytes: 0 };
    expect(migrateSettings(state, 2)).toBe(state);
  });

  it('v1 -> v2 adds the default image-cache cap without touching blurTags', () => {
    const state = { blurTags: ['male:yaoi'] };
    const out = migrateSettings(state, 1) as { blurTags: string[]; imageCacheMaxBytes: number | null };
    expect(out.blurTags).toEqual(['male:yaoi']); // v>=1: no blur re-union
    expect(out.imageCacheMaxBytes).toBe(250 * 1024 * 1024);
  });

  it('handles a persisted state with no blurTags', () => {
    const out = migrateSettings({ theme: 'dark' }, 0) as { blurTags: string[] };
    expect(out.blurTags).toEqual(SAFETY);
  });
});
