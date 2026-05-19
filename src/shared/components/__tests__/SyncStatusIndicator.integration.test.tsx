// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { SyncStatusIndicator } from '../SyncStatusIndicator';
import { useDbStatusStore } from '@/lib/store/db-status';

// Mock useSettingsStore so useT resolves without localStorage.
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (selector: (s: { locale: 'en' }) => unknown) =>
    selector({ locale: 'en' }),
}));

// Mock runTagSync so the retry button can be asserted without a real sync.
const { mockRunTagSync } = vi.hoisted(() => ({ mockRunTagSync: vi.fn() }));
vi.mock('@/lib/db/tag-sync', () => ({
  runTagSync: mockRunTagSync,
}));

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

describe('SyncStatusIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  it('renders nothing in the idle/ready state', () => {
    useDbStatusStore.setState({ dbReady: true });
    const { container } = render(<SyncStatusIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it('shows syncing progress and detail while a sync is in progress', () => {
    useDbStatusStore.setState({
      isSyncing: true,
      syncProgress: 42,
      syncDetail: 'artist 태그 가져오는 중...',
    });
    const { container } = render(<SyncStatusIndicator />);

    expect(container.textContent).toContain('42%');
    expect(container.textContent).toContain('artist 태그 가져오는 중...');
  });

  it('shows the failed state with a retry button when syncError is set', () => {
    useDbStatusStore.setState({ syncError: 'upstream returned 502' });
    const { container, getByRole } = render(<SyncStatusIndicator />);

    expect(container.textContent).toContain('Tag DB sync failed');
    const retry = getByRole('button', { name: 'Retry' });
    expect(retry).toBeTruthy();
  });

  it('clicking retry calls runTagSync', () => {
    useDbStatusStore.setState({ syncError: 'upstream returned 502' });
    const { getByRole } = render(<SyncStatusIndicator />);

    fireEvent.click(getByRole('button', { name: 'Retry' }));
    expect(mockRunTagSync).toHaveBeenCalledTimes(1);
  });

  it('prioritizes the failed state over the syncing state', () => {
    // Both flags set — failure must win so a stale error stays visible.
    useDbStatusStore.setState({ isSyncing: true, syncProgress: 70, syncError: 'boom' });
    const { container } = render(<SyncStatusIndicator />);

    expect(container.textContent).toContain('Tag DB sync failed');
    expect(container.textContent).not.toContain('70%');
  });
});
