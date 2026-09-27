// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { UpdateCheckCard } from '../UpdateCheckCard';
import { UpdateService, type ApplyResult, type CheckResult, type ProgressCallback } from '@/services/UpdateService';
import { useSettingsStore } from '@/lib/store/settings';
import { isAndroid } from '@/lib/utils/platform';

vi.mock('@/lib/utils/platform', () => ({ isAndroid: vi.fn(() => true) }));

vi.mock('@/services/UpdateService', () => ({
  UpdateService: {
    checkForUpdate: vi.fn(),
  },
  CURRENT_VERSION: '0.0.11',
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
  useSettingsStore.setState({ receiveBetaUpdates: false, locale: 'en' });
});

describe('UpdateCheckCard — no layout shift', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an always-present reserved status slot in the idle state', () => {
    render(<UpdateCheckCard />);

    // The slot exists before any check runs, reserving its height so the
    // result later fills pre-allocated space instead of pushing the page down.
    const slot = screen.getByTestId('update-status-slot');
    expect(slot).toBeInTheDocument();
    // Idle: no outcome text yet.
    expect(within(slot).queryByText("You're on the latest version")).not.toBeInTheDocument();
  });

  it('renders the up-to-date result inside the pre-reserved slot (no new flow block)', async () => {
    vi.mocked(UpdateService.checkForUpdate).mockResolvedValue({
      available: false,
    });

    render(<UpdateCheckCard />);
    const slotBefore = screen.getByTestId('update-status-slot');

    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));

    await waitFor(() => {
      expect(screen.getByText("You're on the latest version")).toBeInTheDocument();
    });

    // The message must live inside the same reserved slot element — i.e. it
    // was not appended as a brand-new sibling block in the document flow.
    const slotAfter = screen.getByTestId('update-status-slot');
    expect(slotAfter).toBe(slotBefore);
    expect(within(slotAfter).getByText("You're on the latest version")).toBeInTheDocument();
  });
});

describe('UpdateCheckCard beta channel', () => {
  it('hydrates static markup on Android without a mismatch', async () => {
    const container = document.createElement('div');
    container.innerHTML = renderToString(<UpdateCheckCard />);
    expect(container.querySelector('[role="switch"]')).toBeNull();
    const onRecoverableError = vi.fn();
    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => { root = hydrateRoot(container, <UpdateCheckCard />, { onRecoverableError }); });
    expect(within(container).getByRole('switch', { name: 'Receive beta updates' })).not.toBeChecked();
    expect(onRecoverableError).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('exposes an accessible switch, retains focus, and checks the chosen channel', async () => {
    vi.mocked(UpdateService.checkForUpdate).mockResolvedValue({ available: true, version: '1.2.3', prerelease: true });
    render(<UpdateCheckCard />);
    const toggle = screen.getByRole('switch', { name: 'Receive beta updates' });
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/public beta releases/);
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle).toHaveFocus();
    expect(toggle).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('Beta')).toBeInTheDocument();
    expect(UpdateService.checkForUpdate).toHaveBeenCalledWith({ includePrereleases: true });
    fireEvent.click(toggle);
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await waitFor(() => expect(UpdateService.checkForUpdate).toHaveBeenLastCalledWith({ includePrereleases: false }));
  });

  it('translates the switch, help, and beta label into Korean', async () => {
    useSettingsStore.setState({ locale: 'ko', receiveBetaUpdates: true });
    vi.mocked(UpdateService.checkForUpdate).mockResolvedValue({ available: true, version: '1.2.3', prerelease: true });
    render(<UpdateCheckCard />);
    expect(screen.getByRole('switch', { name: '베타 업데이트 받기' })).toHaveAccessibleDescription(/공개 베타/);
    fireEvent.click(screen.getByRole('button', { name: '업데이트 확인' }));
    expect(await screen.findByText('베타')).toBeInTheDocument();
  });

  it('hides the beta setting outside Android and passes the stable channel', async () => {
    vi.mocked(isAndroid).mockReturnValue(false);
    useSettingsStore.setState({ receiveBetaUpdates: true });
    vi.mocked(UpdateService.checkForUpdate).mockResolvedValue({ available: false });
    render(<UpdateCheckCard />);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await screen.findByText("You're on the latest version");
    expect(UpdateService.checkForUpdate).toHaveBeenCalledWith({ includePrereleases: false });
  });

  it.each(['resolve', 'reject'] as const)('discards a late check %s after switching away and back', async (outcome) => {
    const pending = deferred<CheckResult>();
    vi.mocked(UpdateService.checkForUpdate).mockReturnValueOnce(pending.promise).mockResolvedValue({ available: false });
    render(<UpdateCheckCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    const toggle = screen.getByRole('switch');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Check for updates' })).not.toBeDisabled();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await screen.findByText("You're on the latest version");
    await act(async () => {
      if (outcome === 'resolve') pending.resolve({ available: true, version: '9.9.9' });
      else pending.reject(new Error('late check'));
    });
    expect(screen.getByText("You're on the latest version")).toBeInTheDocument();
    expect(screen.queryByText('v9.9.9')).not.toBeInTheDocument();
    expect(screen.queryByText("Couldn't check for updates")).not.toBeInTheDocument();
  });

  it.each(['resolve', 'reject'] as const)('discards progress and late install %s on a channel change', async (outcome) => {
    const pending = deferred<ApplyResult>();
    let progress!: ProgressCallback;
    vi.mocked(UpdateService.checkForUpdate).mockResolvedValue({
      available: true, version: '1.2.3', prerelease: true,
      applyFn: (callback) => { progress = callback!; return pending.promise; },
    });
    render(<UpdateCheckCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
    act(() => progress(42));
    expect(screen.getByText('Downloading 42%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByTestId('update-status-slot')).toBeEmptyDOMElement();
    await act(async () => {
      progress(90);
      if (outcome === 'resolve') pending.resolve({ status: 'permission_required' });
      else pending.reject(new Error('late install'));
    });
    expect(screen.getByTestId('update-status-slot')).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Check for updates' })).not.toBeDisabled();
  });

  it('clears an existing installation notice when the channel changes', async () => {
    vi.mocked(UpdateService.checkForUpdate).mockResolvedValue({
      available: true, version: '1.2.3',
      applyFn: async () => ({ status: 'installer_started' }),
    });
    render(<UpdateCheckCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
    await screen.findByText(/Installer opened/);
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByTestId('update-status-slot')).toBeEmptyDOMElement();
  });

  it('shows an installation failure when an overlapping native install is rejected', async () => {
    vi.mocked(UpdateService.checkForUpdate).mockResolvedValue({
      available: true, version: '1.2.3', applyFn: async () => { throw new Error('already installing'); },
    });
    render(<UpdateCheckCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
    expect(await screen.findByText("Couldn't start the update. Please try again.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check for updates' })).not.toBeDisabled();
  });

  it('ignores a pending check after unmount', async () => {
    const pending = deferred<CheckResult>();
    vi.mocked(UpdateService.checkForUpdate).mockReturnValue(pending.promise);
    const { unmount, container } = render(<UpdateCheckCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    unmount();
    await act(async () => pending.resolve({ available: true, version: '9.9.9' }));
    expect(container).toBeEmptyDOMElement();
  });
});
