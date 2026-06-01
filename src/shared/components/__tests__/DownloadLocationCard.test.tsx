// @vitest-environment jsdom
/**
 * AC-008 — DownloadLocationCard component tests.
 *
 * Covers:
 *  - hidden on non-Android platforms
 *  - renders on Android
 *  - Reset button calls setDownloadBasePath(null)
 *  - Apply button calls setDownloadBasePath with input value
 *  - "Grant storage permission" button shown only when permission denied
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';

// ── Platform mock — controlled per test ─────────────────────────────────────
let _isAndroid = false;
vi.mock('@/lib/utils/platform', () => ({
  isAndroid: () => _isAndroid,
}));

// ── StoragePermission mock ───────────────────────────────────────────────────
let _granted = true;
vi.mock('@/lib/plugins/storagePermission', () => ({
  StoragePermission: {
    isGranted: () => Promise.resolve({ granted: _granted }),
    request: vi.fn(() => Promise.resolve()),
  },
}));

// ── migrate-downloads mock (AC-007 may not be landed) ───────────────────────
vi.mock('@/lib/storage/migrate-downloads', () => ({
  migrateDownloadsToPublic: vi.fn(() => Promise.resolve()),
}));

// ── i18n passthrough — echo keys ────────────────────────────────────────────
vi.mock('@/lib/i18n/useT', () => ({ useT: () => (k: string) => k }));

import { DownloadLocationCard } from '../DownloadLocationCard';
import { useSettingsStore } from '@/lib/store/settings';

beforeEach(() => {
  _isAndroid = false;
  _granted = true;
  useSettingsStore.getState().setDownloadBasePath(null);
});

async function mount() {
  const utils = render(<DownloadLocationCard />);
  // let StoragePermission.isGranted resolve
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return utils;
}

describe('DownloadLocationCard', () => {
  it('returns null on non-Android platforms', async () => {
    _isAndroid = false;
    const { container } = await mount();
    expect(container.firstChild).toBeNull();
  });

  it('renders on Android', async () => {
    _isAndroid = true;
    await mount();
    expect(screen.getByText('settings.downloadLocation')).toBeTruthy();
  });

  it('Reset button calls setDownloadBasePath(null)', async () => {
    _isAndroid = true;
    useSettingsStore.getState().setDownloadBasePath('/custom/path');
    await mount();
    const resetBtn = screen.getByText('settings.downloadLocation.resetDefault');
    await act(async () => {
      fireEvent.click(resetBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useSettingsStore.getState().downloadBasePath).toBeNull();
  });

  it('Apply button calls setDownloadBasePath with input value', async () => {
    _isAndroid = true;
    await mount();
    const input = screen.getByPlaceholderText('settings.downloadLocation.pathPlaceholder') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: '/storage/emulated/0/MyFolder' } });
    });
    const applyBtn = screen.getByText('Apply');
    await act(async () => {
      fireEvent.click(applyBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useSettingsStore.getState().downloadBasePath).toBe('/storage/emulated/0/MyFolder');
  });

  it('shows grant permission button when permission is denied', async () => {
    _isAndroid = true;
    _granted = false;
    await mount();
    expect(screen.getByText('settings.downloadLocation.grantPermission')).toBeTruthy();
  });

  it('does not show grant permission button when permission is granted', async () => {
    _isAndroid = true;
    _granted = true;
    await mount();
    expect(screen.queryByText('settings.downloadLocation.grantPermission')).toBeNull();
  });

  it('Reset button is disabled when path is already null (default)', async () => {
    _isAndroid = true;
    useSettingsStore.getState().setDownloadBasePath(null);
    await mount();
    const resetBtn = screen.getByText('settings.downloadLocation.resetDefault') as HTMLButtonElement;
    expect(resetBtn.disabled).toBe(true);
  });
});
