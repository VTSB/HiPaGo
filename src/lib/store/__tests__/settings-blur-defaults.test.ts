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
    const out = migrateSettings({ blurTags: ['female:guro', 'male:yaoi'] }, 0) as {
      blurTags: string[];
    };
    expect(out.blurTags.filter((t) => t === 'female:guro')).toHaveLength(1);
    expect(out.blurTags).toEqual(expect.arrayContaining(['male:yaoi', ...SAFETY]));
  });

  it('v5 -> v6 adds secure screen default without touching prior fields', () => {
    const state = {
      blurTags: ['male:yaoi'],
      imageCacheMaxBytes: 0,
      downloadTreeUri: null,
      downloadTreeName: null,
      defaultFilterQuery: '',
    };
    const out = migrateSettings(state, 5) as { secureScreen: boolean };
    expect(out.secureScreen).toBe(true);
  });

  it('v1 -> v2 adds the default image-cache cap without touching blurTags', () => {
    const state = { blurTags: ['male:yaoi'] };
    const out = migrateSettings(state, 1) as {
      blurTags: string[];
      imageCacheMaxBytes: number | null;
    };
    expect(out.blurTags).toEqual(['male:yaoi']); // v>=1: no blur re-union
    expect(out.imageCacheMaxBytes).toBe(250 * 1024 * 1024);
  });

  it('handles a persisted state with no blurTags', () => {
    const out = migrateSettings({ theme: 'dark' }, 0) as { blurTags: string[] };
    expect(out.blurTags).toEqual(SAFETY);
  });
});

describe('v4 migration — downloadBasePath → downloadTreeUri (SAF)', () => {
  it('v3 -> v4: drops downloadBasePath and sets downloadTreeUri/Name to null', () => {
    const state = {
      blurTags: ['male:yaoi'],
      imageCacheMaxBytes: 0,
      downloadBasePath: '/storage/emulated/0/Download',
    };
    const out = migrateSettings(state, 3) as {
      downloadBasePath?: string | null;
      downloadTreeUri: string | null;
      downloadTreeName: string | null;
    };
    // Old absolute-path override cannot be reused as a SAF tree URI — dropped.
    expect(out.downloadBasePath).toBeUndefined();
    expect(out.downloadTreeUri).toBeNull();
    expect(out.downloadTreeName).toBeNull();
  });

  it('v0 -> v4: sets downloadTreeUri null (multi-version jump)', () => {
    const state = { blurTags: ['male:yaoi'] };
    const out = migrateSettings(state, 0) as { downloadTreeUri: string | null };
    expect(out.downloadTreeUri).toBeNull();
  });

  it('v4 -> v5: adds the default result filter without touching SAF fields', () => {
    const state = {
      blurTags: ['male:yaoi'],
      imageCacheMaxBytes: 0,
      downloadTreeUri: 'content://tree/x',
      downloadTreeName: 'X',
    };
    const out = migrateSettings(state, 4) as {
      downloadTreeUri: string | null;
      defaultFilterQuery: string;
    };
    expect(out.downloadTreeUri).toBe('content://tree/x');
    expect(out.defaultFilterQuery).toBe('');
  });

  it('v6 -> v7 adds the library initial tab default without touching prior fields', () => {
    const state = {
      blurTags: ['male:yaoi'],
      imageCacheMaxBytes: 0,
      downloadTreeUri: 'content://tree/x',
      downloadTreeName: 'X',
      defaultFilterQuery: '',
      secureScreen: true,
    };
    const out = migrateSettings(state, 6) as {
      downloadTreeUri: string | null;
      secureScreen: boolean;
      libraryInitialTab: string;
    };
    expect(out.downloadTreeUri).toBe('content://tree/x');
    expect(out.secureScreen).toBe(true);
    expect(out.libraryInitialTab).toBe('favorites');
  });

  it('v7: is a no-op (fields already present, same reference)', () => {
    const state = {
      blurTags: ['male:yaoi'],
      imageCacheMaxBytes: 0,
      downloadTreeUri: 'content://tree/x',
      downloadTreeName: 'X',
      defaultFilterQuery: '',
      secureScreen: true,
      libraryInitialTab: 'downloads',
    };
    const out = migrateSettings(state, 7) as {
      downloadTreeUri: string | null;
      secureScreen: boolean;
      libraryInitialTab: string;
    };
    expect(out.downloadTreeUri).toBe('content://tree/x');
    expect(out.secureScreen).toBe(true);
    expect(out.libraryInitialTab).toBe('downloads');
    expect(out).toBe(state);
  });
});
