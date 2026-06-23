// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetSyncStatus, mockQuery, mockRunTagSync } = vi.hoisted(() => ({
  mockGetSyncStatus: vi.fn(),
  mockQuery: vi.fn(),
  mockRunTagSync: vi.fn(),
}));

vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('@/lib/db/sync-status', () => ({
  getSyncStatus: mockGetSyncStatus,
}));

vi.mock('@/lib/db/adapter', () => ({
  ensureDb: () => Promise.resolve({ query: mockQuery }),
}));

vi.mock('@/lib/db/tag-sync', () => ({
  runTagSync: () => mockRunTagSync(),
}));

import { useDbStatusStore } from '@/lib/store/db-status';
import { TagDbStatusCard } from '../TagDbStatusCard';

async function mount() {
  const utils = render(<TagDbStatusCard />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return utils;
}

describe('TagDbStatusCard', () => {
  beforeEach(() => {
    mockGetSyncStatus.mockResolvedValue(
      JSON.stringify({
        status: 'completed',
        timestamp: Date.now() - 60_000,
        count: 10,
      }),
    );
    mockQuery.mockResolvedValue([{ c: 12_345 }]);
    mockRunTagSync.mockReset();
    useDbStatusStore.setState({
      dbReady: false,
      syncProgress: 0,
      isSyncing: false,
      syncDetail: '',
      tagsStale: false,
      syncError: null,
      dbError: null,
      dbInitStage: null,
    });
  });

  it('shows completed tag DB status with the current tag count', async () => {
    useDbStatusStore.setState({ dbReady: true });
    const { container } = await mount();

    expect(container.textContent).toContain('settings.tagDb.status.ready');
    expect(container.textContent).toContain('12,345');
    expect(container.textContent).toContain('settings.tagDb.lastSync');
    expect(screen.getByText('settings.tagDb.resync')).toBeTruthy();
  });

  it('shows progress and detail while syncing', async () => {
    useDbStatusStore.setState({
      isSyncing: true,
      syncProgress: 42,
      syncDetail: 'artist a',
    });
    const { container } = await mount();

    expect(container.textContent).toContain('settings.tagDb.status.syncing');
    expect(container.textContent).toContain('settings.tagDb.progress 42% · artist a');
    expect(screen.getByText('settings.tagDb.start')).toBeDisabled();
  });

  it('surfaces sync errors and lets the user retry or copy the diagnostic', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useDbStatusStore.setState({ syncError: 'TLS handshake failed', isSyncing: false });
    const { container } = await mount();

    expect(container.textContent).toContain('settings.tagDb.status.failed');
    expect(container.textContent).toContain('TLS handshake failed');

    fireEvent.click(screen.getByText('sync.retry'));
    expect(mockRunTagSync).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByText('db.error.copy'));
    });
    expect(writeText).toHaveBeenCalledWith('TLS handshake failed');
  });
});
