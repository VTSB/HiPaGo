import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, clearAllTables, teardownTestDb, queryAll, queryOne } from './test-db';
import { TAG_TYPE_TO_BYTE, TagType } from '@/lib/utils/types';
import { useDbStatusStore } from '@/lib/store/db-status';
import { getDb } from '../adapter';
import { getSyncStatus, setSyncStatus } from '../sync-status';
import { checkDbReady, SYNC_KEY_TAGS } from '../init';
import { TAG_TYPES } from '@/lib/api/tag-parser';

// ---------------------------------------------------------------------------
// Mock createTagFetcher to SUCCEED — exercises the runtime path
// ---------------------------------------------------------------------------

const mockFetchPage = vi.fn();
const mockDispose = vi.fn();

vi.mock('@/lib/api/tag-fetcher', () => ({
  createTagFetcher: () => ({
    fetchPage: mockFetchPage,
    dispose: mockDispose,
  }),
}));

// Global fetch stub — runtime path should not call it.
const mockGlobalFetch = vi.fn();
vi.stubGlobal('fetch', mockGlobalFetch);

// ---------------------------------------------------------------------------
// Mock useTagI18nStore to capture loadLocale calls
// ---------------------------------------------------------------------------

const mockLoadLocale = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/store/tag-i18n', () => ({
  useTagI18nStore: {
    getState: () => ({ loadLocale: mockLoadLocale }),
  },
}));

// Import runTagSync AFTER all vi.mock calls
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
    syncError: null,
  });
}

/**
 * Build a minimal hitomi.la tag page HTML with the given tags and optional
 * nav letters (for pagination). Tags default to a plain /tag/{name}-all.html
 * href unless overridden.
 */
function makeTagPageHtml(
  tags: Array<{ name: string; count: number; href?: string }>,
  navLetters?: string[],
): string {
  const tagLis = tags
    .map((t) => {
      const href = t.href ?? `/tag/${t.name}-all.html`;
      const countStr = t.count.toLocaleString();
      return `<li><a href="${href}">${t.name}</a> (${countStr})</li>`;
    })
    .join('\n');

  const navLis = (navLetters ?? [])
    .map((l) => `<li><a href="/alltags-${l}.html">${l.toUpperCase()}</a></li>`)
    .join('\n');

  const contentBlock = `<div class="content"><ul>${tagLis}</ul></div>`;
  const navBlock = navLetters ? `<div class="page-content"><ul>${navLis}</ul></div>` : '';

  return contentBlock + navBlock;
}

/** Empty page HTML — no content block, parser returns []. */
const EMPTY_PAGE = '<html></html>';

/** Valid one-tag first page for types that are not the focus of a test. */
function makeRequiredFirstPage(url: string): string {
  const route = url.startsWith('allartists-')
    ? 'artist'
    : url.startsWith('allseries-')
      ? 'series'
      : url.startsWith('allcharacters-')
        ? 'character'
        : url.startsWith('allgroups-')
          ? 'group'
          : 'tag';
  const name = `fixture-${url.replace(/[^a-z0-9]+/gi, '-')}`;
  return makeTagPageHtml([{ name, count: 1, href: `/${route}/${name}-all.html` }]);
}

// ---------------------------------------------------------------------------
// Setup / teardown
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
  mockFetchPage.mockReset();
  mockDispose.mockReset();
  mockGlobalFetch.mockReset();
  mockLoadLocale.mockReset();
  mockLoadLocale.mockResolvedValue(undefined);
  mockGlobalFetch.mockRejectedValue(
    new Error('global fetch should not be called in runtime path tests'),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ===========================================================================
// runTagSync — runtime path
// ===========================================================================

describe('runTagSync — runtime path', () => {
  // -------------------------------------------------------------------------
  // 1. Basic runtime sync success
  // -------------------------------------------------------------------------
  it('basic runtime sync success: inserts tags for all 5 types and marks completed', async () => {
    // Return 1 tag per type's first (and only) page; no nav pages.
    mockFetchPage.mockImplementation((url: string) => {
      if (url.startsWith('allartists-'))
        return Promise.resolve(
          makeTagPageHtml([
            { name: 'artist-alpha', count: 100, href: '/artist/artist-alpha-all.html' },
          ]),
        );
      if (url.startsWith('allseries-'))
        return Promise.resolve(
          makeTagPageHtml([{ name: 'series-a', count: 50, href: '/series/series-a-all.html' }]),
        );
      if (url.startsWith('allcharacters-'))
        return Promise.resolve(
          makeTagPageHtml([{ name: 'char-one', count: 10, href: '/character/char-one-all.html' }]),
        );
      if (url.startsWith('allgroups-'))
        return Promise.resolve(
          makeTagPageHtml([{ name: 'group-x', count: 300, href: '/group/group-x-all.html' }]),
        );
      if (url.startsWith('alltags-'))
        return Promise.resolve(
          makeTagPageHtml([{ name: 'plain-tag', count: 999, href: '/tag/plain-tag-all.html' }]),
        );
      return Promise.resolve(EMPTY_PAGE);
    });

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    // Verify artists
    const artists = await queryAll<{ name: string; count: number }>(
      'SELECT name, count FROM tag WHERE type = ?',
      [TAG_TYPE_TO_BYTE[TagType.ARTIST]],
    );
    expect(artists.map((t) => t.name)).toContain('artist-alpha');
    expect(artists.find((t) => t.name === 'artist-alpha')!.count).toBe(100);

    // Verify series
    const series = await queryAll<{ name: string }>('SELECT name FROM tag WHERE type = ?', [
      TAG_TYPE_TO_BYTE[TagType.SERIES],
    ]);
    expect(series.map((t) => t.name)).toContain('series-a');

    // Verify characters
    const chars = await queryAll<{ name: string }>('SELECT name FROM tag WHERE type = ?', [
      TAG_TYPE_TO_BYTE[TagType.CHARACTER],
    ]);
    expect(chars.map((t) => t.name)).toContain('char-one');

    // Verify groups
    const groups = await queryAll<{ name: string }>('SELECT name FROM tag WHERE type = ?', [
      TAG_TYPE_TO_BYTE[TagType.GROUP],
    ]);
    expect(groups.map((t) => t.name)).toContain('group-x');

    // Verify plain tags
    const plainTags = await queryAll<{ name: string }>('SELECT name FROM tag WHERE type = ?', [
      TAG_TYPE_TO_BYTE[TagType.TAG],
    ]);
    expect(plainTags.map((t) => t.name)).toContain('plain-tag');

    // Completed status
    expect(useDbStatusStore.getState().dbReady).toBe(true);
    expect(useDbStatusStore.getState().isSyncing).toBe(false);
    expect(useDbStatusStore.getState().syncProgress).toBe(100);

    const raw = await getSyncStatus(SYNC_KEY_TAGS);
    const statusData = JSON.parse(raw!);
    expect(statusData.status).toBe('completed');
  });

  it('upserts a tag inserted after the sync snapshot without aborting', async () => {
    mockFetchPage.mockImplementation((url: string) => {
      if (url === 'allartists-a.html') {
        return Promise.resolve(
          makeTagPageHtml([
            { name: 'concurrent-artist', count: 42, href: '/artist/concurrent-artist-all.html' },
          ]),
        );
      }
      return Promise.resolve(makeRequiredFirstPage(url));
    });

    const db = getDb();
    const originalQuery = db.query.bind(db);
    let injected = false;
    const querySpy = vi
      .spyOn(db, 'query')
      .mockImplementation(async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
        const rows = await originalQuery<T>(sql, params);
        if (
          !injected &&
          sql.startsWith('SELECT tagId, name, count FROM tag WHERE type = ?') &&
          params?.[0] === TAG_TYPE_TO_BYTE[TagType.ARTIST]
        ) {
          injected = true;
          await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [
            TAG_TYPE_TO_BYTE[TagType.ARTIST],
            'concurrent-artist',
            0,
          ]);
        }
        return rows;
      });

    try {
      await Promise.all([runTagSync(), vi.runAllTimersAsync()]);
    } finally {
      querySpy.mockRestore();
    }

    const rows = await queryAll<{ count: number }>(
      'SELECT count FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.ARTIST], 'concurrent-artist'],
    );
    expect(injected).toBe(true);
    expect(rows).toEqual([{ count: 42 }]);
    expect(useDbStatusStore.getState().dbReady).toBe(true);
    expect(useDbStatusStore.getState().syncError).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 2. Multiple types processed sequentially
  // -------------------------------------------------------------------------
  it('multiple types processed sequentially: fetchPage called with correct first-page URLs', async () => {
    // Return distinct tags per type so we can verify all 5 were fetched.
    const tagsByType: Record<string, string> = {
      allartists: 'runtime-artist',
      allseries: 'runtime-series',
      allcharacters: 'runtime-character',
      allgroups: 'runtime-group',
      alltags: 'runtime-tag',
    };

    mockFetchPage.mockImplementation((url: string) => {
      for (const [prefix, tagName] of Object.entries(tagsByType)) {
        if (url.startsWith(prefix + '-')) {
          const hrefPrefix = prefix.replace('all', '').replace(/s$/, ''); // rough
          return Promise.resolve(
            makeTagPageHtml([
              { name: tagName, count: 1, href: `/${hrefPrefix}/${tagName}-all.html` },
            ]),
          );
        }
      }
      return Promise.resolve(EMPTY_PAGE);
    });

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    // Verify all 5 TAG_TYPES had their first page requested
    const calledUrls: string[] = mockFetchPage.mock.calls.map((c) => c[0] as string);
    for (const { urlType } of TAG_TYPES) {
      expect(calledUrls).toContain(`all${urlType}-a.html`);
    }

    // Verify all 5 types present in DB
    const typeChecks: Array<[TagType, string]> = [
      [TagType.ARTIST, 'runtime-artist'],
      [TagType.SERIES, 'runtime-series'],
      [TagType.CHARACTER, 'runtime-character'],
      [TagType.GROUP, 'runtime-group'],
      [TagType.TAG, 'runtime-tag'],
    ];
    for (const [tagType, name] of typeChecks) {
      const tag = await queryOne<{ name: string }>(
        'SELECT name FROM tag WHERE type = ? AND name = ?',
        [TAG_TYPE_TO_BYTE[tagType], name],
      );
      expect(tag, `Tag ${name} of type ${tagType} should exist`).toBeDefined();
    }
  });

  // -------------------------------------------------------------------------
  // 3. Female/male tag detection from HTML
  // -------------------------------------------------------------------------
  it('female/male tag detection: href-based gender detection stores correct types', async () => {
    // Only the 'tags' type page has assertions; other required first pages use
    // minimal valid fixtures so the full catalog can complete.
    mockFetchPage.mockImplementation((url: string) => {
      if (url === 'alltags-a.html') {
        return Promise.resolve(
          makeTagPageHtml([
            { name: 'loli ♀', count: 5000, href: '/tag/female:loli-all.html' },
            { name: 'muscle ♂', count: 3000, href: '/tag/male:muscle-all.html' },
          ]),
        );
      }
      return Promise.resolve(makeRequiredFirstPage(url));
    });

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    const femaleLoli = await queryOne<{ name: string; type: number }>(
      'SELECT name, type FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.FEMALE], 'loli'],
    );
    expect(femaleLoli).toBeDefined();
    expect(femaleLoli!.type).toBe(TAG_TYPE_TO_BYTE[TagType.FEMALE]);

    const maleMuscle = await queryOne<{ name: string; type: number }>(
      'SELECT name, type FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.MALE], 'muscle'],
    );
    expect(maleMuscle).toBeDefined();
    expect(maleMuscle!.type).toBe(TAG_TYPE_TO_BYTE[TagType.MALE]);
  });

  // -------------------------------------------------------------------------
  // 4. Multi-page fetch via nav URLs
  // -------------------------------------------------------------------------
  it('multi-page fetch: nav URLs parsed from first page are fetched', async () => {
    // For 'artists', return nav letters b and c on the first page.
    // Other types use minimal valid first pages.
    mockFetchPage.mockImplementation((url: string) => {
      if (url === 'allartists-a.html') {
        return Promise.resolve(
          makeTagPageHtml(
            [{ name: 'artist-a', count: 10, href: '/artist/artist-a-all.html' }],
            ['b', 'c'],
          )
            .replace(
              // Nav links use 'allartists-' prefix, not 'alltags-'
              /href="\/alltags-b\.html"/g,
              'href="/allartists-b.html"',
            )
            .replace(/href="\/alltags-c\.html"/g, 'href="/allartists-c.html"'),
        );
      }
      if (url === 'allartists-b.html') {
        return Promise.resolve(
          makeTagPageHtml([{ name: 'artist-b', count: 20, href: '/artist/artist-b-all.html' }]),
        );
      }
      if (url === 'allartists-c.html') {
        return Promise.resolve(
          makeTagPageHtml([{ name: 'artist-c', count: 30, href: '/artist/artist-c-all.html' }]),
        );
      }
      return Promise.resolve(makeRequiredFirstPage(url));
    });

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    // fetchPage should have been called with all 3 artist URLs
    const calledUrls: string[] = mockFetchPage.mock.calls.map((c) => c[0] as string);
    expect(calledUrls).toContain('allartists-a.html');
    expect(calledUrls).toContain('allartists-b.html');
    expect(calledUrls).toContain('allartists-c.html');

    // All 3 artist tags should be in DB
    const artists = await queryAll<{ name: string }>('SELECT name FROM tag WHERE type = ?', [
      TAG_TYPE_TO_BYTE[TagType.ARTIST],
    ]);
    expect(artists.map((t) => t.name).sort()).toEqual(['artist-a', 'artist-b', 'artist-c']);
  });

  // -------------------------------------------------------------------------
  // 5. Individual page failure continues but does not mark a partial catalog complete
  // -------------------------------------------------------------------------
  it('individual page failure processes remaining pages but leaves sync incomplete after retry', async () => {
    // 'artists' first page has nav letters b and c.
    // Fetching 'b' throws; 'c' succeeds.
    // The implementation collects failed pages for retry — 'b' tags won't appear
    // (retry also fails in this test since we don't set up the retry to succeed).
    let artistAFetched = false;

    mockFetchPage.mockImplementation((url: string) => {
      if (url === 'allartists-a.html') {
        artistAFetched = true;
        return Promise.resolve(
          makeTagPageHtml(
            [{ name: 'artist-page-a', count: 1, href: '/artist/artist-page-a-all.html' }],
            ['b', 'c'],
          )
            .replace(/\/alltags-b\.html/g, '/allartists-b.html')
            .replace(/\/alltags-c\.html/g, '/allartists-c.html'),
        );
      }
      if (url === 'allartists-b.html') {
        return Promise.reject(new Error('Simulated page-b failure'));
      }
      if (url === 'allartists-c.html') {
        return Promise.resolve(
          makeTagPageHtml([
            { name: 'artist-page-c', count: 3, href: '/artist/artist-page-c-all.html' },
          ]),
        );
      }
      return Promise.resolve(makeRequiredFirstPage(url));
    });

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    expect(artistAFetched).toBe(true);

    // Page A and page C tags should be in DB
    const artistA = await queryOne<{ name: string }>(
      'SELECT name FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.ARTIST], 'artist-page-a'],
    );
    expect(artistA).toBeDefined();

    const artistC = await queryOne<{ name: string }>(
      'SELECT name FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.ARTIST], 'artist-page-c'],
    );
    expect(artistC).toBeDefined();

    const state = useDbStatusStore.getState();
    expect(state.dbReady).toBe(false);
    expect(state.isSyncing).toBe(false);
    expect(state.syncError).toContain('Tag sync remained incomplete after retrying 1 page');

    const raw = await getSyncStatus(SYNC_KEY_TAGS);
    expect(JSON.parse(raw!).status).not.toBe('completed');
  });

  it('treats a nav page with no parseable tags as incomplete after retry', async () => {
    mockFetchPage.mockImplementation((url: string) => {
      if (url === 'allartists-a.html') {
        return Promise.resolve(
          makeTagPageHtml(
            [{ name: 'artist-valid-a', count: 1, href: '/artist/artist-valid-a-all.html' }],
            ['b'],
          ).replace(/\/alltags-b\.html/g, '/allartists-b.html'),
        );
      }
      if (url === 'allartists-b.html') return Promise.resolve(EMPTY_PAGE);
      return Promise.resolve(makeRequiredFirstPage(url));
    });

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    expect(mockFetchPage.mock.calls.filter(([url]) => url === 'allartists-b.html')).toHaveLength(2);
    expect(useDbStatusStore.getState().dbReady).toBe(false);
    expect(useDbStatusStore.getState().syncError).toContain('Tag sync remained incomplete');
  });

  it('does not complete when one required first page stays empty while other types are valid', async () => {
    mockFetchPage.mockImplementation((url: string) => {
      if (url === 'allartists-a.html') return Promise.resolve(EMPTY_PAGE);
      return Promise.resolve(
        makeTagPageHtml([{ name: `valid-${url}`, count: 1, href: `/tag/valid-${url}-all.html` }]),
      );
    });

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    expect(mockFetchPage.mock.calls.filter(([url]) => url === 'allartists-a.html')).toHaveLength(2);
    expect(useDbStatusStore.getState().dbReady).toBe(false);
    expect(useDbStatusStore.getState().syncError).toContain(
      'Required first tag page allartists-a.html remained unavailable after retry',
    );
    expect(JSON.parse((await getSyncStatus(SYNC_KEY_TAGS))!).status).not.toBe('completed');
  });

  it('uses navigation from a successful first-page retry', async () => {
    let artistFirstPageAttempts = 0;
    mockFetchPage.mockImplementation((url: string) => {
      if (url === 'allartists-a.html') {
        artistFirstPageAttempts++;
        if (artistFirstPageAttempts === 1) return Promise.resolve(EMPTY_PAGE);
        return Promise.resolve(
          makeTagPageHtml(
            [{ name: 'artist-recovered-a', count: 1, href: '/artist/artist-recovered-a-all.html' }],
            ['b'],
          ).replace(/\/alltags-b\.html/g, '/allartists-b.html'),
        );
      }
      if (url === 'allartists-b.html') {
        return Promise.resolve(
          makeTagPageHtml([
            { name: 'artist-recovered-b', count: 2, href: '/artist/artist-recovered-b-all.html' },
          ]),
        );
      }
      return Promise.resolve(makeTagPageHtml([{ name: `valid-${url}`, count: 1 }]));
    });

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    expect(artistFirstPageAttempts).toBe(2);
    expect(mockFetchPage).toHaveBeenCalledWith('allartists-b.html');
    expect(useDbStatusStore.getState().dbReady).toBe(true);
    expect(
      await queryOne<{ name: string }>('SELECT name FROM tag WHERE name = ?', [
        'artist-recovered-b',
      ]),
    ).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 6. Failed pages retried in pass 2
  // -------------------------------------------------------------------------
  it('failed pages retried in pass 2: retry succeeds and tags end up in DB', async () => {
    let bFetchCount = 0;

    mockFetchPage.mockImplementation((url: string) => {
      if (url === 'allartists-a.html') {
        return Promise.resolve(
          makeTagPageHtml(
            [{ name: 'artist-retry-a', count: 5, href: '/artist/artist-retry-a-all.html' }],
            ['b'],
          ).replace(/\/alltags-b\.html/g, '/allartists-b.html'),
        );
      }
      if (url === 'allartists-b.html') {
        bFetchCount++;
        if (bFetchCount === 1) {
          // First attempt (pass 1) fails
          return Promise.reject(new Error('Simulated pass-1 failure'));
        }
        // Second attempt (pass 2 retry) succeeds
        return Promise.resolve(
          makeTagPageHtml([
            { name: 'artist-retry-b', count: 10, href: '/artist/artist-retry-b-all.html' },
          ]),
        );
      }
      return Promise.resolve(makeRequiredFirstPage(url));
    });

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    // b was attempted twice
    expect(bFetchCount).toBe(2);

    // Both tags should be in DB after pass 2
    const tagA = await queryOne<{ name: string }>(
      'SELECT name FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.ARTIST], 'artist-retry-a'],
    );
    expect(tagA).toBeDefined();

    const tagB = await queryOne<{ name: string }>(
      'SELECT name FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.ARTIST], 'artist-retry-b'],
    );
    expect(tagB).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 7. Checkpoint saved to sync_status
  // -------------------------------------------------------------------------
  it('checkpoint saved to sync_status after processing letter pages', async () => {
    // Give 'artists' a nav page so a checkpoint is written.
    mockFetchPage.mockImplementation((url: string) => {
      if (url === 'allartists-a.html') {
        return Promise.resolve(
          makeTagPageHtml(
            [{ name: 'chk-artist', count: 1, href: '/artist/chk-artist-all.html' }],
            ['b'],
          ).replace(/\/alltags-b\.html/g, '/allartists-b.html'),
        );
      }
      if (url === 'allartists-b.html') {
        return Promise.resolve(
          makeTagPageHtml([
            { name: 'chk-artist-b', count: 2, href: '/artist/chk-artist-b-all.html' },
          ]),
        );
      }
      return Promise.resolve(makeRequiredFirstPage(url));
    });

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    // After sync completes the final status is 'completed', but during processing
    // a 'loading' checkpoint was written. The raw value at end is 'completed'.
    // We verify the sync completed and the final row exists.
    const raw = await getSyncStatus(SYNC_KEY_TAGS);
    expect(raw).not.toBeNull();
    const data = JSON.parse(raw!);
    // After completion the status transitions to 'completed'
    expect(data.status).toBe('completed');

    // Also verify the checkpoint structure was used: we can only confirm
    // indirectly that setSyncStatus was called with 'loading' by checking tags.
    const chkArtist = await queryOne<{ name: string }>(
      'SELECT name FROM tag WHERE type = ? AND name = ?',
      [TAG_TYPE_TO_BYTE[TagType.ARTIST], 'chk-artist-b'],
    );
    expect(chkArtist).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 8. Progress updates monotonically
  // -------------------------------------------------------------------------
  it('progress updates monotonically throughout runtime sync', async () => {
    const progressValues: number[] = [];
    const originalSetSyncProgress = useDbStatusStore.getState().setSyncProgress;

    useDbStatusStore.setState({
      setSyncProgress: (progress: number) => {
        progressValues.push(progress);
        originalSetSyncProgress(progress);
      },
    });

    mockFetchPage.mockImplementation((url: string) => Promise.resolve(makeRequiredFirstPage(url)));

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    expect(progressValues.length).toBeGreaterThan(0);
    for (let i = 1; i < progressValues.length; i++) {
      expect(progressValues[i]).toBeGreaterThanOrEqual(progressValues[i - 1]);
    }
  });

  // -------------------------------------------------------------------------
  // 9. syncDetail updates with type info
  // -------------------------------------------------------------------------
  it('syncDetail is updated with urlType names during sync', async () => {
    const detailValues: string[] = [];
    const originalSetSyncDetail = useDbStatusStore.getState().setSyncDetail;

    useDbStatusStore.setState({
      setSyncDetail: (detail: string) => {
        detailValues.push(detail);
        originalSetSyncDetail(detail);
      },
    });

    mockFetchPage.mockImplementation((url: string) => Promise.resolve(makeRequiredFirstPage(url)));

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    // At least one detail message should mention each urlType
    for (const { urlType } of TAG_TYPES) {
      const found = detailValues.some((d) => d.includes(urlType));
      expect(found, `syncDetail should mention urlType "${urlType}"`).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // 10. fetcher.dispose() always called
  // -------------------------------------------------------------------------
  it('fetcher.dispose() is called even when fetchPage throws', async () => {
    mockFetchPage.mockRejectedValue(new Error('Simulated total failure'));

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 11. loadLocale called after runtime sync (not applyKoreanLocalization)
  // -------------------------------------------------------------------------
  it('calls useTagI18nStore.loadLocale after sync completes', async () => {
    // Must insert at least one tag — an all-empty sync is now treated as a
    // failure (see empty-guard test below), so it would not "complete".
    mockFetchPage.mockResolvedValue(
      makeTagPageHtml([{ name: 'locale-tag', count: 1, href: '/tag/locale-tag-all.html' }]),
    );

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    expect(useDbStatusStore.getState().dbReady).toBe(true);
    expect(mockLoadLocale).toHaveBeenCalledOnce();
  });

  it('keeps the completed sync state when locale reload fails', async () => {
    mockFetchPage.mockResolvedValue(makeTagPageHtml([{ name: 'locale-failure-tag', count: 1 }]));
    mockLoadLocale.mockRejectedValueOnce(new Error('locale bundle failed'));

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    const state = useDbStatusStore.getState();
    expect(state.dbReady).toBe(true);
    expect(state.isSyncing).toBe(false);
    expect(state.syncError).toBeNull();

    const raw = await getSyncStatus(SYNC_KEY_TAGS);
    expect(JSON.parse(raw!).status).toBe('completed');
  });

  it('ignores a duplicate trigger while the first sync is claiming its DB status', async () => {
    mockFetchPage.mockResolvedValue(makeTagPageHtml([{ name: 'single-run-tag', count: 1 }]));

    await Promise.all([runTagSync(), runTagSync(), vi.runAllTimersAsync()]);

    expect(mockFetchPage).toHaveBeenCalledTimes(TAG_TYPES.length);
    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(useDbStatusStore.getState().dbReady).toBe(true);
    expect(useDbStatusStore.getState().syncError).toBeNull();
  });

  // -------------------------------------------------------------------------
  // AC-004 — explicit sync-failure state
  // -------------------------------------------------------------------------
  it('sets syncError in the store when the sync fails', async () => {
    mockFetchPage.mockRejectedValue(new Error('upstream returned 502'));

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    const state = useDbStatusStore.getState();
    expect(state.syncError).toBe('upstream returned 502');
    expect(state.isSyncing).toBe(false);
    expect(state.dbReady).toBe(false);
  });

  it('restores a previous completed status when a background refresh fails', async () => {
    const previousStatus = JSON.stringify({
      status: 'completed',
      timestamp: 1,
      count: 1,
    });
    await setSyncStatus(SYNC_KEY_TAGS, previousStatus);
    await getDb().execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [
      TAG_TYPE_TO_BYTE[TagType.TAG],
      'existing-catalog-tag',
      1,
    ]);
    useDbStatusStore.setState({ dbReady: true, tagsStale: true });
    mockFetchPage.mockRejectedValue(new Error('background refresh failed'));

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    expect(await getSyncStatus(SYNC_KEY_TAGS)).toBe(previousStatus);
    expect(useDbStatusStore.getState().dbReady).toBe(true);
    expect(useDbStatusStore.getState().tagsStale).toBe(true);
    expect(useDbStatusStore.getState().syncError).toBe('background refresh failed');

    resetStore();
    expect(await checkDbReady()).toBe(true);
  });

  it('clears a stale syncError when a new sync starts', async () => {
    // Seed a prior failure.
    useDbStatusStore.getState().setSyncError('previous failure');
    // A successful sync must insert at least one tag (an all-empty sync is now a
    // failure — see the empty-guard test below).
    mockFetchPage.mockResolvedValue(
      makeTagPageHtml([{ name: 'fresh-tag', count: 1, href: '/tag/fresh-tag-all.html' }]),
    );

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    // Successful sync clears the error and marks the DB ready.
    expect(useDbStatusStore.getState().syncError).toBeNull();
    expect(useDbStatusStore.getState().dbReady).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Empty-guard — a sync that parses 0 tags from every page must NOT complete
  // -------------------------------------------------------------------------
  it('does NOT mark completed when every page parses to 0 tags (blocked/challenge response)', async () => {
    // Simulates a device whose fetches return a challenge/blocked page: HTTP 200
    // but no parseable tags. Without the guard this would markTagSyncCompleted(0),
    // poisoning dbReady with an empty tag table.
    mockFetchPage.mockResolvedValue(EMPTY_PAGE);

    await Promise.all([runTagSync(), vi.runAllTimersAsync()]);

    const state = useDbStatusStore.getState();
    expect(state.dbReady).toBe(false);
    expect(state.syncError).toBeTruthy();
    expect(state.isSyncing).toBe(false);

    // sync_status must NOT be 'completed' (so the next launch retries).
    const raw = await getSyncStatus(SYNC_KEY_TAGS);
    const data = raw ? JSON.parse(raw) : null;
    expect(data?.status).not.toBe('completed');

    // The tag table stays empty.
    const tags = await queryAll<{ name: string }>('SELECT name FROM tag', []);
    expect(tags.length).toBe(0);
  });
});
