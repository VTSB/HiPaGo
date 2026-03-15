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
