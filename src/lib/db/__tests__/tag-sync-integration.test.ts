import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from 'vitest';
import { setupTestDb, clearAllTables, teardownTestDb, queryAll, queryOne } from './test-db';
import { getDb } from '../adapter';
import { TAG_TYPE_TO_BYTE, TagType } from '@/lib/utils/types';
import { useDbStatusStore } from '@/lib/store/db-status';
import {
  getSyncStatus,
  setSyncStatus,
  deleteSyncStatus,
} from '../sync-status';
import {
  SYNC_KEY_TAGS,
  parseSyncData,
  checkDbReady,
  markTagSyncCompleted,
  markTagSyncLoading,
} from '../init';

// ---------------------------------------------------------------------------
// Mock useTagI18nStore to capture loadLocale calls
// ---------------------------------------------------------------------------

const mockLoadLocale = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/store/tag-i18n', () => ({
  useTagI18nStore: {
    getState: () => ({ loadLocale: mockLoadLocale }),
  },
}));

// ---------------------------------------------------------------------------
// Mock runtime tag fetching (must be before import)
// ---------------------------------------------------------------------------

interface MockTag { name: string; count: number; type: string }

let mockParsedTags: MockTag[] = [];
let mockFetchPageShouldFail = false;

vi.mock('@/lib/api/tag-fetcher', () => ({
  createTagFetcher: () => ({
    fetchPage: () => {
      if (mockFetchPageShouldFail) return Promise.reject(new Error('Mock: fetch failed'));
      return Promise.resolve('<html>mock</html>');
    },
    dispose: () => Promise.resolve(),
  }),
}));

vi.mock('@/lib/api/tag-parser', () => ({
  TAG_TYPES: [{ urlType: 'mock', defaultType: 'tag' }],
  parseTagsFromHtml: () => {
    const tags = [...mockParsedTags];
    mockParsedTags = [];
    return tags;
  },
  parseNavUrls: () => [],
}));

// Import tag-sync AFTER mock is set up
import { runTagSync } from '../tag-sync';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore() {
  useDbStatusStore.setState({
    dbReady: false,
    syncProgress: 0,
    isSyncing: false,
    syncDetail: '',
    tagsStale: false,
  });
}

/** Set mock tags that runTagSync will "parse" from runtime pages */
function setMockTags(tags: Record<string, Array<[string, number]>>): void {
  mockParsedTags = [];
  for (const [type, entries] of Object.entries(tags)) {
    for (const [name, count] of entries) {
      mockParsedTags.push({ name, count, type });
    }
  }
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await clearAllTables();
  resetStore();
  mockParsedTags = [];
  mockFetchPageShouldFail = false;
  mockLoadLocale.mockReset();
  mockLoadLocale.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. useDbStatusStore — state management
// ===========================================================================

describe('useDbStatusStore', () => {
  it('initial state is dbReady=false, syncProgress=0, isSyncing=false', () => {
    resetStore();
    const state = useDbStatusStore.getState();
    expect(state.dbReady).toBe(false);
    expect(state.syncProgress).toBe(0);
    expect(state.isSyncing).toBe(false);
  });

  it('setDbReady updates dbReady', () => {
    useDbStatusStore.getState().setDbReady(true);
    expect(useDbStatusStore.getState().dbReady).toBe(true);
    useDbStatusStore.getState().setDbReady(false);
    expect(useDbStatusStore.getState().dbReady).toBe(false);
  });

  it('setSyncProgress updates syncProgress', () => {
    useDbStatusStore.getState().setSyncProgress(42);
    expect(useDbStatusStore.getState().syncProgress).toBe(42);
    useDbStatusStore.getState().setSyncProgress(100);
    expect(useDbStatusStore.getState().syncProgress).toBe(100);
  });

  it('setIsSyncing updates isSyncing', () => {
    useDbStatusStore.getState().setIsSyncing(true);
    expect(useDbStatusStore.getState().isSyncing).toBe(true);
    useDbStatusStore.getState().setIsSyncing(false);
    expect(useDbStatusStore.getState().isSyncing).toBe(false);
  });

  it('multiple state updates are independent', () => {
    useDbStatusStore.getState().setDbReady(true);
    useDbStatusStore.getState().setSyncProgress(50);
    useDbStatusStore.getState().setIsSyncing(true);

    const state = useDbStatusStore.getState();
    expect(state.dbReady).toBe(true);
    expect(state.syncProgress).toBe(50);
    expect(state.isSyncing).toBe(true);
  });

  it('setSyncDetail updates syncDetail', () => {
    useDbStatusStore.getState().setSyncDetail('artists (3/26)');
    expect(useDbStatusStore.getState().syncDetail).toBe('artists (3/26)');
  });

  it('setTagsStale updates tagsStale', () => {
    useDbStatusStore.getState().setTagsStale(true);
    expect(useDbStatusStore.getState().tagsStale).toBe(true);
  });
});

// ===========================================================================
// 2. parseSyncData
// ===========================================================================

describe('parseSyncData', () => {
  it('returns null for null input', () => {
    expect(parseSyncData(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseSyncData('')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseSyncData('not-json')).toBeNull();
    expect(parseSyncData('{broken')).toBeNull();
  });

  it('parses completed status', () => {
    const data = JSON.stringify({ status: 'completed', timestamp: 1000, count: 500 });
    const result = parseSyncData(data);
    expect(result).toEqual({ status: 'completed', timestamp: 1000, count: 500 });
  });

  it('parses loading status without count', () => {
    const data = JSON.stringify({ status: 'loading', timestamp: 2000 });
    const result = parseSyncData(data);
    expect(result).toEqual({ status: 'loading', timestamp: 2000 });
    expect(result!.count).toBeUndefined();
  });
});

// ===========================================================================
// 3. checkDbReady — init.ts
// ===========================================================================

describe('checkDbReady', () => {
  it('returns false and sets dbReady=false when no sync_status entry', async () => {
    const ready = await checkDbReady();
    expect(ready).toBe(false);
    expect(useDbStatusStore.getState().dbReady).toBe(false);
  });

  it('returns false when sync_status is "loading"', async () => {
    await setSyncStatus(SYNC_KEY_TAGS, JSON.stringify({ status: 'loading', timestamp: 1000 }));
    const ready = await checkDbReady();
    expect(ready).toBe(false);
    expect(useDbStatusStore.getState().dbReady).toBe(false);
  });

  it('returns true and sets dbReady=true when sync_status is "completed"', async () => {
    await setSyncStatus(SYNC_KEY_TAGS, JSON.stringify({ status: 'completed', timestamp: 1000, count: 100 }));
    // checkDbReady now also verifies the tag table is non-empty.
    await getDb().execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [
      TAG_TYPE_TO_BYTE[TagType.TAG], 'ready-tag', 1,
    ]);
    const ready = await checkDbReady();
    expect(ready).toBe(true);
    expect(useDbStatusStore.getState().dbReady).toBe(true);
  });

  it('returns false when sync_status has invalid JSON', async () => {
    await setSyncStatus(SYNC_KEY_TAGS, 'garbage-data');
    const ready = await checkDbReady();
    expect(ready).toBe(false);
    expect(useDbStatusStore.getState().dbReady).toBe(false);
  });
});

// ===========================================================================
// 4. markTagSyncCompleted — init.ts
// ===========================================================================

describe('markTagSyncCompleted', () => {
  it('writes completed status to sync_status table', async () => {
    await markTagSyncCompleted(500);
    const raw = await getSyncStatus(SYNC_KEY_TAGS);
    expect(raw).not.toBeNull();
    const data = JSON.parse(raw!);
    expect(data.status).toBe('completed');
    expect(data.count).toBe(500);
    expect(typeof data.timestamp).toBe('number');
  });

  it('sets dbReady=true, clears sync flags, and syncProgress=100', async () => {
    useDbStatusStore.getState().setIsSyncing(true);
    useDbStatusStore.getState().setSyncProgress(50);
    useDbStatusStore.getState().setTagsStale(true);

    await markTagSyncCompleted(100);

    const state = useDbStatusStore.getState();
    expect(state.dbReady).toBe(true);
    expect(state.isSyncing).toBe(false);
    expect(state.syncProgress).toBe(100);
    expect(state.tagsStale).toBe(false);
  });
});

// ===========================================================================
// 5. markTagSyncLoading — init.ts
// ===========================================================================

describe('markTagSyncLoading', () => {
  it('writes loading status to sync_status table', async () => {
    await markTagSyncLoading();
    const raw = await getSyncStatus(SYNC_KEY_TAGS);
    expect(raw).not.toBeNull();
    const data = JSON.parse(raw!);
    expect(data.status).toBe('loading');
    expect(typeof data.timestamp).toBe('number');
  });

  it('sets isSyncing=true', async () => {
    await markTagSyncLoading();
    expect(useDbStatusStore.getState().isSyncing).toBe(true);
  });
});

// ===========================================================================
// 6. runTagSync — full integration flow
// ===========================================================================

describe('runTagSync — full flow', () => {
  it('inserts tags into DB and marks completed', async () => {
    setMockTags({
      female: [['ahegao', 5000], ['anal', 3000]],
      male: [['blowjob', 4000]],
    });

    await runTagSync();

    const femaleTags = await queryAll<{ tagId: number; name: string; count: number }>(
      'SELECT tagId, name, count FROM tag WHERE type = ?',
      [TAG_TYPE_TO_BYTE[TagType.FEMALE]],
    );
    const femaleNames = femaleTags.map((t) => t.name);
    expect(femaleNames).toContain('ahegao');
    expect(femaleNames).toContain('anal');
    expect(femaleTags.find((t) => t.name === 'ahegao')!.count).toBe(5000);
    expect(femaleTags.find((t) => t.name === 'anal')!.count).toBe(3000);

    const maleTags = await queryAll<{ name: string; count: number }>(
      'SELECT name, count FROM tag WHERE type = ?',
      [TAG_TYPE_TO_BYTE[TagType.MALE]],
    );
    expect(maleTags.find((t) => t.name === 'blowjob')!.count).toBe(4000);

    expect(useDbStatusStore.getState().dbReady).toBe(true);
    expect(useDbStatusStore.getState().isSyncing).toBe(false);
    expect(useDbStatusStore.getState().syncProgress).toBe(100);

    const raw = await getSyncStatus(SYNC_KEY_TAGS);
    const data = JSON.parse(raw!);
    expect(data.status).toBe('completed');
    expect(data.count).toBe(3);
  });

  it('updates existing tag count on re-sync', async () => {
    await getDb().execute(
      'INSERT INTO tag (type, name, count) VALUES (?, ?, ?)',
      [TAG_TYPE_TO_BYTE[TagType.FEMALE], 'ahegao', 100],
    );

    setMockTags({
      female: [['ahegao', 9999]],
    });

    await runTagSync();

    const tag = await queryOne<{ count: number }>(
      'SELECT count FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.FEMALE], 'ahegao'],
    );
    expect(tag!.count).toBe(9999);

    const allFemale = await queryAll<{ name: string }>(
      'SELECT name FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.FEMALE], 'ahegao'],
    );
    expect(allFemale).toHaveLength(1);
  });

  it('skips update when existing tag has same count', async () => {
    await getDb().execute(
      'INSERT INTO tag (type, name, count) VALUES (?, ?, ?)',
      [TAG_TYPE_TO_BYTE[TagType.FEMALE], 'ahegao', 5000],
    );

    setMockTags({
      female: [['ahegao', 5000]],
    });

    await runTagSync();

    const tag = await queryOne<{ count: number }>(
      'SELECT count FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.FEMALE], 'ahegao'],
    );
    expect(tag!.count).toBe(5000);
  });

  it('prevents duplicate sync when isSyncing=true', async () => {
    useDbStatusStore.getState().setIsSyncing(true);
    setMockTags({ female: [['test', 1]] });

    await runTagSync();

    // sync was skipped — no tags inserted
    const tags = await queryAll<{ name: string }>(
      'SELECT name FROM tag WHERE type = ?',
      [TAG_TYPE_TO_BYTE[TagType.FEMALE]],
    );
    expect(tags).toHaveLength(0);
  });

  it('handles API errors gracefully — sets isSyncing=false on fetch failure', async () => {
    mockFetchPageShouldFail = true;

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runTagSync();
    consoleSpy.mockRestore();

    expect(useDbStatusStore.getState().isSyncing).toBe(false);
  });

  it('updates syncProgress as types complete', async () => {
    const progressValues: number[] = [];
    const originalSetSyncProgress = useDbStatusStore.getState().setSyncProgress;

    useDbStatusStore.setState({
      setSyncProgress: (progress: number) => {
        progressValues.push(progress);
        originalSetSyncProgress(progress);
      },
    });

    setMockTags({});
    await runTagSync();

    expect(progressValues.length).toBeGreaterThan(0);
    for (let i = 1; i < progressValues.length; i++) {
      expect(progressValues[i]).toBeGreaterThanOrEqual(progressValues[i - 1]);
    }
  });

  it('inserts tags into correct type bytes per field', async () => {
    setMockTags({
      female: [['test_female', 1]],
      male: [['test_male', 2]],
      artist: [['test_artist', 3]],
      series: [['test_series', 4]],
      group: [['test_group', 5]],
      character: [['test_character', 6]],
      tag: [['test_tag', 7]],
    });

    await runTagSync();

    const checks: Array<[TagType, string, number]> = [
      [TagType.FEMALE, 'test_female', 1],
      [TagType.MALE, 'test_male', 2],
      [TagType.ARTIST, 'test_artist', 3],
      [TagType.SERIES, 'test_series', 4],
      [TagType.GROUP, 'test_group', 5],
      [TagType.CHARACTER, 'test_character', 6],
      [TagType.TAG, 'test_tag', 7],
    ];

    for (const [tagType, name, expectedCount] of checks) {
      const tag = await queryOne<{ tagId: number; count: number }>(
        'SELECT tagId, count FROM tag WHERE type = ? AND name = ?',
        [TAG_TYPE_TO_BYTE[tagType], name],
      );
      expect(tag, `Tag ${name} of type ${tagType} should exist`).toBeDefined();
      expect(tag!.count).toBe(expectedCount);
    }
  });
});

// ===========================================================================
// 7. runTagSync — catastrophic failure handling
// ===========================================================================

describe('runTagSync — catastrophic failure', () => {
  it('sets isSyncing=false on unexpected error during sync', async () => {
    mockFetchPageShouldFail = true;

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runTagSync();
    consoleSpy.mockRestore();

    expect(useDbStatusStore.getState().isSyncing).toBe(false);
  });
});

// ===========================================================================
// 8. Tag sync calls loadLocale (not applyKoreanLocalization)
// ===========================================================================

describe('tag sync completes without applyKoreanLocalization', () => {
  it('calls useTagI18nStore.loadLocale after sync completes, not applyKoreanLocalization', async () => {
    setMockTags({
      female: [['blowjob', 10000]],
    });

    await runTagSync();

    expect(useDbStatusStore.getState().dbReady).toBe(true);
    expect(mockLoadLocale).toHaveBeenCalledOnce();
  });

  it('calls loadLocale after sync completes, not before', async () => {
    setMockTags({
      female: [['blowjob', 10000], ['loli', 8000]],
    });

    expect(mockLoadLocale).not.toHaveBeenCalled();
    await runTagSync();
    expect(mockLoadLocale).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// 9. Full lifecycle: checkDbReady -> runTagSync -> checkDbReady again
// ===========================================================================

describe('Full lifecycle', () => {
  it('fresh DB -> checkDbReady=false -> runTagSync -> checkDbReady=true', async () => {
    const ready1 = await checkDbReady();
    expect(ready1).toBe(false);
    expect(useDbStatusStore.getState().dbReady).toBe(false);

    setMockTags({ tag: [['lifecycle-tag', 1]] });
    await runTagSync();

    const ready2 = await checkDbReady();
    expect(ready2).toBe(true);
    expect(useDbStatusStore.getState().dbReady).toBe(true);
  });

  it('completed DB -> checkDbReady=true -> no sync needed', async () => {
    await setSyncStatus(SYNC_KEY_TAGS, JSON.stringify({ status: 'completed', timestamp: 1000, count: 100 }));
    // checkDbReady now also verifies the tag table is non-empty.
    await getDb().execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [
      TAG_TYPE_TO_BYTE[TagType.TAG], 'completed-tag', 1,
    ]);

    const ready = await checkDbReady();
    expect(ready).toBe(true);
    expect(useDbStatusStore.getState().dbReady).toBe(true);
  });

  it('loading state from interrupted sync -> checkDbReady=false -> re-sync completes', async () => {
    await setSyncStatus(SYNC_KEY_TAGS, JSON.stringify({ status: 'loading', timestamp: 1000 }));

    const ready1 = await checkDbReady();
    expect(ready1).toBe(false);

    setMockTags({ tag: [['resync-tag', 1]] });
    await runTagSync();

    const ready2 = await checkDbReady();
    expect(ready2).toBe(true);
  });

  it('sync_status persists across checkDbReady calls', async () => {
    setMockTags({ tag: [['persist-tag', 1]] });
    await runTagSync();

    resetStore();
    expect(useDbStatusStore.getState().dbReady).toBe(false);

    const ready = await checkDbReady();
    expect(ready).toBe(true);
    expect(useDbStatusStore.getState().dbReady).toBe(true);
  });
});

// ===========================================================================
// 10. sync_status CRUD integration (init.ts keys)
// ===========================================================================

describe('sync_status CRUD with init keys', () => {
  it('SYNC_KEY_TAGS constant is "init:tags"', () => {
    expect(SYNC_KEY_TAGS).toBe('init:tags');
  });

  it('markTagSyncLoading then markTagSyncCompleted transitions correctly', async () => {
    await markTagSyncLoading();

    let raw = await getSyncStatus(SYNC_KEY_TAGS);
    let data = JSON.parse(raw!);
    expect(data.status).toBe('loading');

    await markTagSyncCompleted(42);

    raw = await getSyncStatus(SYNC_KEY_TAGS);
    data = JSON.parse(raw!);
    expect(data.status).toBe('completed');
    expect(data.count).toBe(42);
  });

  it('deleteSyncStatus clears the init:tags key', async () => {
    await markTagSyncCompleted(100);
    expect(await getSyncStatus(SYNC_KEY_TAGS)).not.toBeNull();

    await deleteSyncStatus(SYNC_KEY_TAGS);
    expect(await getSyncStatus(SYNC_KEY_TAGS)).toBeNull();

    const ready = await checkDbReady();
    expect(ready).toBe(false);
  });
});

// ===========================================================================
// 11. Multiple tags — batch insert correctness
// ===========================================================================

describe('Batch insert correctness', () => {
  it('inserts multiple tags from a single type in the JSON response', async () => {
    setMockTags({
      artist: [
        ['artist_a1', 100],
        ['artist_a2', 200],
        ['artist_a3', 300],
        ['artist_a4', 400],
        ['artist_a5', 500],
      ],
    });

    await runTagSync();

    const artists = await queryAll<{ name: string }>(
      'SELECT name FROM tag WHERE type = ?',
      [TAG_TYPE_TO_BYTE[TagType.ARTIST]],
    );
    expect(artists).toHaveLength(5);
    expect(artists.map((t) => t.name).sort()).toEqual([
      'artist_a1', 'artist_a2', 'artist_a3', 'artist_a4', 'artist_a5',
    ]);
  });

  it('tags from different fields but same name are stored separately', async () => {
    setMockTags({
      female: [['blowjob', 10000]],
      male: [['blowjob', 8000]],
    });

    await runTagSync();

    const femaleTag = await queryOne<{ tagId: number; count: number }>(
      'SELECT tagId, count FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.FEMALE], 'blowjob'],
    );
    const maleTag = await queryOne<{ tagId: number; count: number }>(
      'SELECT tagId, count FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.MALE], 'blowjob'],
    );

    expect(femaleTag).toBeDefined();
    expect(maleTag).toBeDefined();
    expect(femaleTag!.tagId).not.toBe(maleTag!.tagId);
    expect(femaleTag!.count).toBe(10000);
    expect(maleTag!.count).toBe(8000);
  });
});

// ===========================================================================
// 12. Integration with local search after sync
// ===========================================================================

describe('Local search works after sync', () => {
  it('searchLocalTags finds tags inserted by runTagSync', async () => {
    const { searchLocalTags } = await import('../search-local');

    setMockTags({
      female: [['beauty mark', 34000], ['big breasts', 120000]],
    });

    await runTagSync();

    const results = await searchLocalTags('bea');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.tag === 'beauty mark')).toBe(true);
    expect(results.find((r) => r.tag === 'beauty mark')!.tagType).toBe(TagType.FEMALE);
  });

  it('hasLocalSearchData returns true after sync', async () => {
    const { hasLocalSearchData } = await import('../search-local');

    setMockTags({
      tag: [['action', 1000]],
    });

    expect(await hasLocalSearchData()).toBe(false);
    await runTagSync();
    expect(await hasLocalSearchData()).toBe(true);
  });
});
