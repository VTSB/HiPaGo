// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

const mockRunTagSync = vi.fn();
vi.mock('@/lib/db/tag-sync', () => ({
  runTagSync: () => mockRunTagSync(),
}));

import { SyncErrorBanner } from '../SyncErrorBanner';
import { useDbStatusStore } from '@/lib/store/db-status';

describe('SyncErrorBanner', () => {
  afterEach(() => {
    useDbStatusStore.setState({ syncError: null, isSyncing: false });
    mockRunTagSync.mockReset();
  });

  it('renders nothing when there is no syncError', () => {
    useDbStatusStore.setState({ syncError: null, isSyncing: false });
    const { container } = render(<SyncErrorBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing while a (re)sync is in progress', () => {
    useDbStatusStore.setState({ syncError: 'stale error', isSyncing: true });
    const { container } = render(<SyncErrorBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('surfaces the actual syncError message so the on-device cause is visible', () => {
    useDbStatusStore.setState({
      syncError: 'Tag sync produced 0 tags — every page returned no parseable tags',
      isSyncing: false,
    });
    const { container } = render(<SyncErrorBanner />);
    expect(container.textContent).toContain(
      'Tag sync produced 0 tags — every page returned no parseable tags',
    );
  });

  it('retry button triggers runTagSync', () => {
    useDbStatusStore.setState({ syncError: 'boom', isSyncing: false });
    const { getByText } = render(<SyncErrorBanner />);
    act(() => {
      fireEvent.click(getByText('sync.retry'));
    });
    expect(mockRunTagSync).toHaveBeenCalledTimes(1);
  });

  it('copies the error message via the Copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useDbStatusStore.setState({ syncError: 'network: TLS handshake failed', isSyncing: false });
    const { getByText } = render(<SyncErrorBanner />);
    await act(async () => {
      fireEvent.click(getByText('db.error.copy'));
    });
    expect(writeText).toHaveBeenCalledWith('network: TLS handshake failed');
  });
});
