import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock sync-status module
vi.mock('../sync-status', () => ({
  getSyncStatus: vi.fn(),
  setSyncStatus: vi.fn(),
}));

// Mock db-status store
vi.mock('@/lib/store/db-status', () => ({
  useDbStatusStore: {
    getState: vi.fn(),
  },
}));

// Mock the DB adapter — checkDbReady probes the tag table row count.
const mockQuery = vi.fn();
vi.mock('../adapter', () => ({
  ensureDb: vi.fn(async () => ({ query: mockQuery })),
}));

import { getSyncStatus } from '../sync-status';
import { useDbStatusStore } from '@/lib/store/db-status';
import { checkDbReady } from '../init';

const mockGetSyncStatus = getSyncStatus as ReturnType<typeof vi.fn>;
const mockGetState = useDbStatusStore.getState as ReturnType<typeof vi.fn>;

const mockSetDbReady = vi.fn();
const mockSetTagsStale = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockGetState.mockReturnValue({
    setDbReady: mockSetDbReady,
    setTagsStale: mockSetTagsStale,
  });
  // Default: tag table is populated, so a 'completed' status stays ready=true.
  mockQuery.mockResolvedValue([{ c: 50000 }]);
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe('checkDbReady — tag staleness window (14 days)', () => {
  it('tags synced 10 days ago are NOT stale (within 14-day window)', async () => {
    const tenDaysAgo = Date.now() - 10 * DAY_MS;
    mockGetSyncStatus.mockResolvedValue(
      JSON.stringify({ status: 'completed', timestamp: tenDaysAgo }),
    );

    await checkDbReady();

    expect(mockSetTagsStale).not.toHaveBeenCalledWith(true);
  });

  it('tags synced 15 days ago ARE stale', async () => {
    const fifteenDaysAgo = Date.now() - 15 * DAY_MS;
    mockGetSyncStatus.mockResolvedValue(
      JSON.stringify({ status: 'completed', timestamp: fifteenDaysAgo }),
    );

    await checkDbReady();

    expect(mockSetTagsStale).toHaveBeenCalledWith(true);
  });
});

describe('checkDbReady — tag table row validation', () => {
  it('status completed but tag table EMPTY → not ready (forces re-sync)', async () => {
    mockGetSyncStatus.mockResolvedValue(
      JSON.stringify({ status: 'completed', timestamp: Date.now() }),
    );
    mockQuery.mockResolvedValue([{ c: 0 }]);

    const ready = await checkDbReady();

    expect(ready).toBe(false);
    expect(mockSetDbReady).toHaveBeenCalledWith(false);
    // An empty table is not "stale" — it just needs a (re)sync.
    expect(mockSetTagsStale).not.toHaveBeenCalledWith(true);
  });

  it('status completed and tag table populated → ready', async () => {
    mockGetSyncStatus.mockResolvedValue(
      JSON.stringify({ status: 'completed', timestamp: Date.now() }),
    );
    mockQuery.mockResolvedValue([{ c: 42000 }]);

    const ready = await checkDbReady();

    expect(ready).toBe(true);
    expect(mockSetDbReady).toHaveBeenCalledWith(true);
  });

  it('status not completed → not ready, and the table is not probed', async () => {
    mockGetSyncStatus.mockResolvedValue(
      JSON.stringify({ status: 'loading', timestamp: Date.now() }),
    );

    const ready = await checkDbReady();

    expect(ready).toBe(false);
    expect(mockSetDbReady).toHaveBeenCalledWith(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('count probe failure falls back to the completed flag (does not block boot)', async () => {
    mockGetSyncStatus.mockResolvedValue(
      JSON.stringify({ status: 'completed', timestamp: Date.now() }),
    );
    mockQuery.mockRejectedValue(new Error('db locked'));

    const ready = await checkDbReady();

    expect(ready).toBe(true);
    expect(mockSetDbReady).toHaveBeenCalledWith(true);
  });
});
