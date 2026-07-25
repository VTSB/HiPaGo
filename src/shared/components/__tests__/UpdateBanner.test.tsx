// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { UpdateBanner } from '../UpdateBanner';
import { UpdateService, type CheckResult } from '@/services/UpdateService';

vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('@/services/UpdateService', () => ({
  UpdateService: {
    checkForUpdate: vi.fn(),
  },
}));

function mockAvailable(result: Partial<CheckResult>) {
  vi.mocked(UpdateService.checkForUpdate).mockResolvedValue({
    available: true,
    version: '0.0.12',
    notes: undefined,
    ...result,
  });
}

describe('UpdateBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recovers when Android sends the user to unknown-app settings', async () => {
    mockAvailable({
      applyFn: vi.fn().mockResolvedValue({ status: 'permission_required' }),
    });

    render(<UpdateBanner />);
    fireEvent.click(await screen.findByRole('button', { name: 'update.banner.install' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'update.banner.install' })).not.toBeDisabled();
    });
    expect(screen.getByText('update.banner.permissionRequired')).toBeInTheDocument();
    expect(screen.queryByText('update.banner.installing')).not.toBeInTheDocument();
  });

  it('recovers after opening the system installer so cancel can be retried', async () => {
    mockAvailable({
      applyFn: vi.fn().mockResolvedValue({ status: 'installer_started' }),
    });

    render(<UpdateBanner />);
    fireEvent.click(await screen.findByRole('button', { name: 'update.banner.install' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'update.banner.install' })).not.toBeDisabled();
    });
    expect(screen.getByText('update.banner.installerStarted')).toBeInTheDocument();
    expect(screen.queryByText('update.banner.installing')).not.toBeInTheDocument();
  });

  it('observes automatic check failures without showing a disruptive banner', async () => {
    const error = new Error('updater permission denied');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(UpdateService.checkForUpdate).mockRejectedValue(error);

    render(<UpdateBanner />);

    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith('[UpdateBanner] check failed', error);
    });
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
