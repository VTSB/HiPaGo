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
// Mock apiClient for tag-sync (must be before import)
// ---------------------------------------------------------------------------

const mockFetchUrl = vi.fn();

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    fetchUrl: (...args: unknown[]) => mockFetchUrl(...args),
  },
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
  });
}

/** Create a mock JSON response for fetchUrl */
function mockJsonResponse(data: unknown): Response {
  return {
    json: () => Promise.resolve(data),
    ok: true,
    status: 200,
  } as unknown as Response;
}

/** Create tag API data: [tagName, count, namespace] tuples */
function makeTagData(
  tags: Array<{ name: string; count: number; ns?: string }>,
): Array<[string, number, string]> {
  return tags.map(({ name, count, ns }) => [name, count, ns || '']);
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
  mockFetchUrl.mockReset();
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

  it('sets dbReady=true, isSyncing=false, syncProgress=100', async () => {
    useDbStatusStore.getState().setIsSyncing(true);
    useDbStatusStore.getState().setSyncProgress(50);

    await markTagSyncCompleted(100);

    const state = useDbStatusStore.getState();
    expect(state.dbReady).toBe(true);
    expect(state.isSyncing).toBe(false);
    expect(state.syncProgress).toBe(100);
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
  it('inserts tags from API responses into DB and marks completed', async () => {
    mockFetchUrl.mockImplementation((url: string) => {
      if (url === '/api/tagindex/female/a.json') {
        return Promise.resolve(mockJsonResponse(
          makeTagData([
            { name: 'ahegao', count: 5000 },
            { name: 'anal', count: 3000 },
          ]),
        ));
      }
      if (url === '/api/tagindex/male/b.json') {
        return Promise.resolve(mockJsonResponse(
          makeTagData([
            { name: 'blowjob', count: 4000 },
          ]),
        ));
      }
      return Promise.resolve(mockJsonResponse([]));
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

    mockFetchUrl.mockImplementation((url: string) => {
      if (url === '/api/tagindex/female/a.json') {
        return Promise.resolve(mockJsonResponse(
          makeTagData([{ name: 'ahegao', count: 9999 }]),
        ));
      }
      return Promise.resolve(mockJsonResponse([]));
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

    mockFetchUrl.mockImplementation((url: string) => {
      if (url === '/api/tagindex/female/a.json') {
        return Promise.resolve(mockJsonResponse(
          makeTagData([{ name: 'ahegao', count: 5000 }]),
        ));
      }
      return Promise.resolve(mockJsonResponse([]));
    });

    await runTagSync();

    const tag = await queryOne<{ count: number }>(
      'SELECT count FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.FEMALE], 'ahegao'],
    );
    expect(tag!.count).toBe(5000);
  });

  it('skips empty tagName entries', async () => {
    mockFetchUrl.mockImplementation((url: string) => {
      if (url === '/api/tagindex/female/a.json') {
        return Promise.resolve(mockJsonResponse([
          ['', 100, 'female'],
          ['ahegao', 200, 'female'],
        ]));
      }
      return Promise.resolve(mockJsonResponse([]));
    });

    await runTagSync();

    const allFemale = await queryAll<{ name: string }>(
      'SELECT name FROM tag WHERE type = ?',
      [TAG_TYPE_TO_BYTE[TagType.FEMALE]],
    );
    expect(allFemale).toHaveLength(1);
    expect(allFemale[0].name).toBe('ahegao');
  });

  it('prevents duplicate sync when isSyncing=true', async () => {
    useDbStatusStore.getState().setIsSyncing(true);
    mockFetchUrl.mockResolvedValue(mockJsonResponse([]));

    await runTagSync();

    expect(mockFetchUrl).not.toHaveBeenCalled();
  });

  it('handles API errors gracefully — returns empty for failed prefix', async () => {
    mockFetchUrl.mockImplementation((url: string) => {
      if (url === '/api/tagindex/female/a.json') {
        return Promise.reject(new Error('Network error'));
      }
      if (url === '/api/tagindex/female/b.json') {
        return Promise.resolve(mockJsonResponse(
          makeTagData([{ name: 'beauty mark', count: 300 }]),
        ));
      }
      return Promise.resolve(mockJsonResponse([]));
    });

    await runTagSync();

    const allFemale = await queryAll<{ name: string }>(
      'SELECT name FROM tag WHERE type = ?',
      [TAG_TYPE_TO_BYTE[TagType.FEMALE]],
    );
    const names = allFemale.map((t) => t.name);
    expect(names).toContain('beauty mark');
    expect(names).not.toContain('ahegao');

    expect(useDbStatusStore.getState().dbReady).toBe(true);
  });

  it('updates syncProgress as prefixes complete', async () => {
    const progressValues: number[] = [];
    const originalSetSyncProgress = useDbStatusStore.getState().setSyncProgress;

    useDbStatusStore.setState({
      setSyncProgress: (progress: number) => {
        progressValues.push(progress);
        originalSetSyncProgress(progress);
      },
    });

    mockFetchUrl.mockResolvedValue(mockJsonResponse([]));
    await runTagSync();

    expect(progressValues.length).toBeGreaterThan(0);
    for (let i = 1; i < progressValues.length; i++) {
      expect(progressValues[i]).toBeGreaterThanOrEqual(progressValues[i - 1]);
    }
    const maxBeforeCompletion = Math.max(...progressValues.filter((v) => v < 100));
    expect(maxBeforeCompletion).toBeLessThanOrEqual(95);
  });

  it('fetches all 7 fields x 36 prefixes = 252 API calls', async () => {
    mockFetchUrl.mockResolvedValue(mockJsonResponse([]));
    await runTagSync();
    expect(mockFetchUrl).toHaveBeenCalledTimes(252);
  });

  it('calls correct URL pattern for each field/prefix', async () => {
    mockFetchUrl.mockResolvedValue(mockJsonResponse([]));
    await runTagSync();

    expect(mockFetchUrl).toHaveBeenCalledWith('/api/tagindex/female/a.json');
    expect(mockFetchUrl).toHaveBeenCalledWith('/api/tagindex/male/z.json');
    expect(mockFetchUrl).toHaveBeenCalledWith('/api/tagindex/artist/0.json');
    expect(mockFetchUrl).toHaveBeenCalledWith('/api/tagindex/series/9.json');
    expect(mockFetchUrl).toHaveBeenCalledWith('/api/tagindex/group/m.json');
    expect(mockFetchUrl).toHaveBeenCalledWith('/api/tagindex/character/k.json');
    expect(mockFetchUrl).toHaveBeenCalledWith('/api/tagindex/tag/x.json');
  });

  it('inserts tags into correct type bytes per field', async () => {
    const fieldData: Record<string, Array<[string, number, string]>> = {
      'female/t': makeTagData([{ name: 'test_female', count: 1 }]),
      'male/t': makeTagData([{ name: 'test_male', count: 2 }]),
      'artist/t': makeTagData([{ name: 'test_artist', count: 3 }]),
      'series/t': makeTagData([{ name: 'test_series', count: 4 }]),
      'group/t': makeTagData([{ name: 'test_group', count: 5 }]),
      'character/t': makeTagData([{ name: 'test_character', count: 6 }]),
      'tag/t': makeTagData([{ name: 'test_tag', count: 7 }]),
    };

    mockFetchUrl.mockImplementation((url: string) => {
      for (const [key, data] of Object.entries(fieldData)) {
        if (url === `/api/tagindex/${key}.json`) {
          return Promise.resolve(mockJsonResponse(data));
        }
      }
      return Promise.resolve(mockJsonResponse([]));
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
    let callCount = 0;
    mockFetchUrl.mockImplementation(() => {
      callCount++;
      if (callCount > 5) {
        throw new Error('Catastrophic failure');
      }
      return Promise.resolve(mockJsonResponse([]));
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runTagSync();
    consoleSpy.mockRestore();

    expect(useDbStatusStore.getState().isSyncing).toBe(false);
  });
});

// ===========================================================================
// 8. Korean localization integration
// ===========================================================================

describe('Korean localization', () => {
  it('populates tag_i18n for matching tags after sync', async () => {
    mockFetchUrl.mockImplementation((url: string) => {
      if (url === '/api/tagindex/female/b.json') {
        return Promise.resolve(mockJsonResponse(
          makeTagData([{ name: 'blowjob', count: 10000 }]),
        ));
      }
      if (url === '/api/tagindex/female/l.json') {
        return Promise.resolve(mockJsonResponse(
          makeTagData([{ name: 'loli', count: 8000 }]),
        ));
      }
      if (url === '/api/tagindex/male/m.json') {
        return Promise.resolve(mockJsonResponse(
          makeTagData([{ name: 'muscle', count: 3000 }]),
        ));
      }
      return Promise.resolve(mockJsonResponse([]));
    });

    await runTagSync();

    const femaleBlowjob = await queryOne<{ tagId: number }>(
      'SELECT tagId FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.FEMALE], 'blowjob'],
    );
    expect(femaleBlowjob).toBeDefined();
    const i18n1 = await queryOne<{ local: string }>(
      'SELECT local FROM tag_i18n WHERE tagId = ?',
      [femaleBlowjob!.tagId],
    );
    expect(i18n1).toBeDefined();
    expect(i18n1!.local).toBe('펠라');

    const femaleLoli = await queryOne<{ tagId: number }>(
      'SELECT tagId FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.FEMALE], 'loli'],
    );
    expect(femaleLoli).toBeDefined();
    const i18n2 = await queryOne<{ local: string }>(
      'SELECT local FROM tag_i18n WHERE tagId = ?',
      [femaleLoli!.tagId],
    );
    expect(i18n2).toBeDefined();
    expect(i18n2!.local).toBe('로리');

    const maleMuscle = await queryOne<{ tagId: number }>(
      'SELECT tagId FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.MALE], 'muscle'],
    );
    expect(maleMuscle).toBeDefined();
    const i18n3 = await queryOne<{ local: string }>(
      'SELECT local FROM tag_i18n WHERE tagId = ?',
      [maleMuscle!.tagId],
    );
    expect(i18n3).toBeDefined();
    expect(i18n3!.local).toBe('근육');
  });

  it('does not create i18n entry for tags without Korean translation', async () => {
    mockFetchUrl.mockImplementation((url: string) => {
      if (url === '/api/tagindex/female/x.json') {
        return Promise.resolve(mockJsonResponse(
          makeTagData([{ name: 'xray', count: 500 }]),
        ));
      }
      return Promise.resolve(mockJsonResponse([]));
    });

    await runTagSync();

    const tag = await queryOne<{ tagId: number }>(
      'SELECT tagId FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.FEMALE], 'xray'],
    );
    expect(tag).toBeDefined();
    const i18n = await queryOne<{ local: string }>(
      'SELECT local FROM tag_i18n WHERE tagId = ?',
      [tag!.tagId],
    );
    expect(i18n).toBeUndefined();
  });

  it('applies series localization correctly', async () => {
    mockFetchUrl.mockImplementation((url: string) => {
      if (url === '/api/tagindex/series/b.json') {
        return Promise.resolve(mockJsonResponse(
          makeTagData([{ name: 'bleach', count: 2000 }]),
        ));
      }
      return Promise.resolve(mockJsonResponse([]));
    });

    await runTagSync();

    const tag = await queryOne<{ tagId: number }>(
      'SELECT tagId FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.SERIES], 'bleach'],
    );
    expect(tag).toBeDefined();
    const i18n = await queryOne<{ local: string }>(
      'SELECT local FROM tag_i18n WHERE tagId = ?',
      [tag!.tagId],
    );
    expect(i18n).toBeDefined();
    expect(i18n!.local).toBe('블리치');
  });

  it('applies character localization correctly', async () => {
    mockFetchUrl.mockImplementation((url: string) => {
      if (url === '/api/tagindex/character/s.json') {
        return Promise.resolve(mockJsonResponse(
          makeTagData([{ name: 'sailor moon', count: 1500 }]),
        ));
      }
      return Promise.resolve(mockJsonResponse([]));
    });

    await runTagSync();

    const tag = await queryOne<{ tagId: number }>(
      'SELECT tagId FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.CHARACTER], 'sailor moon'],
    );
    expect(tag).toBeDefined();
    const i18n = await queryOne<{ local: string }>(
      'SELECT local FROM tag_i18n WHERE tagId = ?',
      [tag!.tagId],
    );
    expect(i18n).toBeDefined();
    expect(i18n!.local).toBe('세일러 문');
  });

  it('skips fields not in KOREAN_FIELD_MAP', async () => {
    mockFetchUrl.mockResolvedValue(mockJsonResponse([]));
    await runTagSync();
    expect(useDbStatusStore.getState().dbReady).toBe(true);
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

    mockFetchUrl.mockResolvedValue(mockJsonResponse([]));
    await runTagSync();

    const ready2 = await checkDbReady();
    expect(ready2).toBe(true);
    expect(useDbStatusStore.getState().dbReady).toBe(true);
  });

  it('completed DB -> checkDbReady=true -> no sync needed', async () => {
    await setSyncStatus(SYNC_KEY_TAGS, JSON.stringify({ status: 'completed', timestamp: 1000, count: 100 }));

    const ready = await checkDbReady();
    expect(ready).toBe(true);
    expect(useDbStatusStore.getState().dbReady).toBe(true);
  });

  it('loading state from interrupted sync -> checkDbReady=false -> re-sync completes', async () => {
    await setSyncStatus(SYNC_KEY_TAGS, JSON.stringify({ status: 'loading', timestamp: 1000 }));

    const ready1 = await checkDbReady();
    expect(ready1).toBe(false);

    mockFetchUrl.mockResolvedValue(mockJsonResponse([]));
    await runTagSync();

    const ready2 = await checkDbReady();
    expect(ready2).toBe(true);
  });

  it('sync_status persists across checkDbReady calls', async () => {
    mockFetchUrl.mockResolvedValue(mockJsonResponse([]));
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
// 11. Concurrency behavior
// ===========================================================================

describe('Concurrency control', () => {
  it('does not exceed 3 concurrent requests per field', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    mockFetchUrl.mockImplementation(() => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      return new Promise<Response>((resolve) => {
        setTimeout(() => {
          currentConcurrent--;
          resolve(mockJsonResponse([]));
        }, 1);
      });
    });

    await runTagSync();

    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });
});

// ===========================================================================
// 12. Multiple tags per prefix — batch insert correctness
// ===========================================================================

describe('Batch insert correctness', () => {
  it('inserts multiple tags from a single prefix response', async () => {
    mockFetchUrl.mockImplementation((url: string) => {
      if (url === '/api/tagindex/artist/a.json') {
        return Promise.resolve(mockJsonResponse(
          makeTagData([
            { name: 'artist_a1', count: 100 },
            { name: 'artist_a2', count: 200 },
            { name: 'artist_a3', count: 300 },
            { name: 'artist_a4', count: 400 },
            { name: 'artist_a5', count: 500 },
          ]),
        ));
      }
      return Promise.resolve(mockJsonResponse([]));
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
    mockFetchUrl.mockImplementation((url: string) => {
      if (url === '/api/tagindex/female/b.json') {
        return Promise.resolve(mockJsonResponse(
          makeTagData([{ name: 'blowjob', count: 10000 }]),
        ));
      }
      if (url === '/api/tagindex/male/b.json') {
        return Promise.resolve(mockJsonResponse(
          makeTagData([{ name: 'blowjob', count: 8000 }]),
        ));
      }
      return Promise.resolve(mockJsonResponse([]));
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
// 13. Integration with local search after sync
// ===========================================================================

describe('Local search works after sync', () => {
  it('searchLocalTags finds tags inserted by runTagSync', async () => {
    const { searchLocalTags } = await import('../search-local');

    mockFetchUrl.mockImplementation((url: string) => {
      if (url === '/api/tagindex/female/b.json') {
        return Promise.resolve(mockJsonResponse(
          makeTagData([
            { name: 'beauty mark', count: 34000 },
            { name: 'big breasts', count: 120000 },
          ]),
        ));
      }
      return Promise.resolve(mockJsonResponse([]));
    });

    await runTagSync();

    const results = await searchLocalTags('bea');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.tag === 'beauty mark')).toBe(true);
    expect(results.find((r) => r.tag === 'beauty mark')!.tagType).toBe(TagType.FEMALE);
  });

  it('searchLocalTags finds Korean i18n after sync', async () => {
    const { searchLocalTags } = await import('../search-local');

    mockFetchUrl.mockImplementation((url: string) => {
      if (url === '/api/tagindex/female/b.json') {
        return Promise.resolve(mockJsonResponse(
          makeTagData([{ name: 'blowjob', count: 50000 }]),
        ));
      }
      return Promise.resolve(mockJsonResponse([]));
    });

    await runTagSync();

    const results = await searchLocalTags('펠');
    expect(results.some((r) => r.tag === 'blowjob')).toBe(true);
  });

  it('hasLocalSearchData returns true after sync', async () => {
    const { hasLocalSearchData } = await import('../search-local');

    mockFetchUrl.mockImplementation((url: string) => {
      if (url === '/api/tagindex/tag/a.json') {
        return Promise.resolve(mockJsonResponse(
          makeTagData([{ name: 'action', count: 1000 }]),
        ));
      }
      return Promise.resolve(mockJsonResponse([]));
    });

    expect(await hasLocalSearchData()).toBe(false);
    await runTagSync();
    expect(await hasLocalSearchData()).toBe(true);
  });
});
