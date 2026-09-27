// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { UpdateBanner } from '../UpdateBanner';
import { UpdateService, type ApplyResult, type CheckResult, type ProgressCallback } from '@/services/UpdateService';
import { useSettingsStore } from '@/lib/store/settings';
import { isAndroid } from '@/lib/utils/platform';

vi.mock('@/lib/utils/platform', () => ({ isAndroid: vi.fn(() => true) }));

vi.mock('@/services/UpdateService', () => ({
  UpdateService: {
    checkForUpdate: vi.fn(),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isAndroid).mockReturnValue(true);
  sessionStorage.clear();
  useSettingsStore.setState({ receiveBetaUpdates: false, locale: 'en' });
});

function mockAvailable(result: Partial<CheckResult>) {
  vi.mocked(UpdateService.checkForUpdate).mockResolvedValue({
    available: true,
    version: '0.0.12',
    notes: undefined,
    ...result,
  });
}

describe('UpdateBanner Android install recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('recovers when Android sends the user to unknown-app settings', async () => {
    mockAvailable({
      applyFn: vi.fn().mockResolvedValue({ status: 'permission_required' }),
    });

    render(<UpdateBanner />);
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Install' })).not.toBeDisabled();
    });
    expect(screen.getByText(/Allow installs/)).toBeInTheDocument();
    expect(screen.queryByText('Installing…')).not.toBeInTheDocument();
  });

  it('recovers after opening the system installer so cancel can be retried', async () => {
    mockAvailable({
      applyFn: vi.fn().mockResolvedValue({ status: 'installer_started' }),
    });

    render(<UpdateBanner />);
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Install' })).not.toBeDisabled();
    });
    expect(screen.getByText(/Installer opened/)).toBeInTheDocument();
    expect(screen.queryByText('Installing…')).not.toBeInTheDocument();
  });
});

describe('UpdateBanner beta channel', () => {
  it('rechecks with the stored Android choice and labels beta results', async () => {
    mockAvailable({ prerelease: true });
    render(<UpdateBanner />);
    await screen.findByRole('region');
    expect(UpdateService.checkForUpdate).toHaveBeenCalledWith({ includePrereleases: false });
    act(() => useSettingsStore.getState().setReceiveBetaUpdates(true));
    expect(await screen.findByText('Beta')).toBeInTheDocument();
    expect(UpdateService.checkForUpdate).toHaveBeenLastCalledWith({ includePrereleases: true });
  });

  it('ignores the beta preference outside Android', async () => {
    vi.mocked(isAndroid).mockReturnValue(false);
    mockAvailable({});
    render(<UpdateBanner />);
    await screen.findByRole('region');
    act(() => useSettingsStore.getState().setReceiveBetaUpdates(true));
    expect(UpdateService.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(UpdateService.checkForUpdate).toHaveBeenCalledWith({ includePrereleases: false });
  });

  it('stays hidden without an available update, including the web no-op result', async () => {
    vi.mocked(isAndroid).mockReturnValue(false);
    vi.mocked(UpdateService.checkForUpdate).mockResolvedValue({ available: false });
    const { container } = render(<UpdateBanner />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it('immediately clears the old result and ignores its pending check after switching back', async () => {
    const oldCheck = deferred<CheckResult>();
    const nextCheck = deferred<CheckResult>();
    vi.mocked(UpdateService.checkForUpdate)
      .mockResolvedValueOnce({ available: true, version: '1.0.0' })
      .mockReturnValueOnce(oldCheck.promise)
      .mockReturnValueOnce(nextCheck.promise);
    render(<UpdateBanner />);
    await screen.findByText('v1.0.0');
    act(() => useSettingsStore.getState().setReceiveBetaUpdates(true));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    act(() => useSettingsStore.getState().setReceiveBetaUpdates(false));
    await act(async () => nextCheck.resolve({ available: true, version: '2.0.0' }));
    await act(async () => oldCheck.resolve({ available: true, version: '9.9.9', prerelease: true }));
    expect(screen.getByText('v2.0.0')).toBeInTheDocument();
    expect(screen.queryByText('v9.9.9')).not.toBeInTheDocument();
  });

  it.each(['resolve', 'reject'] as const)('ignores old install progress and %s while a new channel is displayed', async (outcome) => {
    const pending = deferred<ApplyResult>();
    let progress!: ProgressCallback;
    vi.mocked(UpdateService.checkForUpdate)
      .mockResolvedValueOnce({
        available: true, version: '1.0.0',
        applyFn: (callback) => { progress = callback!; return pending.promise; },
      })
      .mockResolvedValueOnce({ available: true, version: '2.0.0', prerelease: true, notes: 'Fresh notes' });
    render(<UpdateBanner />);
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
    act(() => progress(42));
    expect(screen.getByRole('button', { name: 'Downloading 42%' })).toBeDisabled();
    act(() => useSettingsStore.getState().setReceiveBetaUpdates(true));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    await screen.findByText('v2.0.0');
    await act(async () => {
      progress(90);
      if (outcome === 'resolve') pending.resolve({ status: 'permission_required' });
      else pending.reject(new Error('late install'));
    });
    expect(screen.getByText('Fresh notes')).toBeInTheDocument();
    expect(screen.queryByText(/Allow installs|Downloading|Couldn't start/)).not.toBeInTheDocument();
  });

  it('clears the old install notice when changing channels', async () => {
    vi.mocked(UpdateService.checkForUpdate)
      .mockResolvedValueOnce({ available: true, version: '1.0.0', applyFn: async () => ({ status: 'permission_required' }) })
      .mockResolvedValueOnce({ available: true, version: '2.0.0', notes: 'Fresh notes' });
    render(<UpdateBanner />);
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
    await screen.findByText(/Allow installs/);
    act(() => useSettingsStore.getState().setReceiveBetaUpdates(true));
    expect(screen.queryByText(/Allow installs/)).not.toBeInTheDocument();
    await screen.findByText('Fresh notes');
  });

  it('ignores callbacks after the banner unmounts', async () => {
    const pending = deferred<ApplyResult>();
    let progress!: ProgressCallback;
    mockAvailable({ applyFn: (callback) => { progress = callback!; return pending.promise; } });
    const { container, unmount } = render(<UpdateBanner />);
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
    unmount();
    await act(async () => {
      progress(90);
      pending.resolve({ status: 'installer_started' });
    });
    expect(container).toBeEmptyDOMElement();
  });
});
