// @vitest-environment jsdom
/**
 * AC-07 — DownloadLocationCard SAF picker tests.
 *
 * Covers:
 *  - hidden on non-Android platforms
 *  - renders on Android with "select folder" when none chosen
 *  - picking a folder stores the tree URI + name and shows "change"/"clear"
 *  - clearing releases the tree and resets the mirror
 *  - mount reconciles the settings mirror with the native persisted tree
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';

// ── Platform mock — controlled per test ─────────────────────────────────────
let _isAndroid = false;
vi.mock('@/lib/utils/platform', () => ({
  isAndroid: () => _isAndroid,
}));

// ── PublicLibrary mock ───────────────────────────────────────────────────────
const pub = vi.hoisted(() => ({
  getTree: vi.fn(),
  openDocumentTree: vi.fn(),
  clearTree: vi.fn(),
}));
vi.mock('@/lib/plugins/publicLibrary', () => ({ PublicLibrary: pub }));

const backup = vi.hoisted(() => ({
  preparePublicBackupForTreeSelection: vi.fn(),
  activatePublicBackupForSelectedTree: vi.fn(),
  resumePublicBackupAfterTreeSelection: vi.fn(),
}));
vi.mock('@/lib/storage/public-backup', () => backup);

// ── i18n passthrough — echo keys ────────────────────────────────────────────
vi.mock('@/lib/i18n/useT', () => ({ useT: () => (k: string) => k }));

import { DownloadLocationCard } from '../DownloadLocationCard';
import { useSettingsStore } from '@/lib/store/settings';

beforeEach(() => {
  _isAndroid = false;
  pub.getTree.mockReset().mockResolvedValue({ treeUri: null, displayName: null, valid: false });
  pub.openDocumentTree.mockReset();
  pub.clearTree.mockReset().mockResolvedValue(undefined);
  backup.preparePublicBackupForTreeSelection.mockReset().mockResolvedValue(undefined);
  backup.activatePublicBackupForSelectedTree.mockReset().mockResolvedValue({
    treeAvailable: true,
    settingsRestored: false,
    downloadsImported: 0,
    downloadsDiscovered: 0,
    partialDownloads: 0,
    skipped: 0,
    failed: 0,
  });
  backup.resumePublicBackupAfterTreeSelection.mockReset();
  useSettingsStore.getState().setDownloadTree(null, null);
});

async function mount() {
  const utils = render(<DownloadLocationCard />);
  // let getTree() reconcile resolve
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return utils;
}

describe('DownloadLocationCard (SAF)', () => {
  it('returns null on non-Android platforms', async () => {
    _isAndroid = false;
    const { container } = await mount();
    expect(container.firstChild).toBeNull();
  });

  it('renders on Android with a select-folder button when none chosen', async () => {
    _isAndroid = true;
    await mount();
    expect(screen.getByText('settings.downloadLocation')).toBeTruthy();
    expect(screen.getByText('settings.downloadLocation.select')).toBeTruthy();
    expect(screen.getByText('settings.downloadLocation.notSelected')).toBeTruthy();
    expect(screen.getByText('settings.downloadLocation.backupDesc')).toBeTruthy();
  });

  it('freezes backup writes before picking, then restores and activates the selected tree', async () => {
    _isAndroid = true;
    pub.openDocumentTree.mockResolvedValue({
      treeUri: 'content://tree/abc',
      displayName: 'MyDownloads',
    });
    await mount();
    const pick = screen.getByText('settings.downloadLocation.select');
    fireEvent.click(pick);
    await waitFor(() => {
      expect(backup.activatePublicBackupForSelectedTree).toHaveBeenCalledWith({
        restoreSettings: true,
      });
    });
    expect(useSettingsStore.getState().downloadTreeUri).toBe('content://tree/abc');
    expect(useSettingsStore.getState().downloadTreeName).toBe('MyDownloads');
    expect(backup.preparePublicBackupForTreeSelection).toHaveBeenCalledTimes(1);
    expect(backup.preparePublicBackupForTreeSelection.mock.invocationCallOrder[0]).toBeLessThan(
      pub.openDocumentTree.mock.invocationCallOrder[0],
    );
    expect(pub.openDocumentTree.mock.invocationCallOrder[0]).toBeLessThan(
      backup.activatePublicBackupForSelectedTree.mock.invocationCallOrder[0],
    );
    expect(backup.resumePublicBackupAfterTreeSelection).toHaveBeenCalledTimes(1);
    expect(screen.getByText('MyDownloads')).toBeTruthy();
    expect(screen.getByText('settings.downloadLocation.change')).toBeTruthy();
    expect(screen.getByText('settings.downloadLocation.restore')).toBeTruthy();
    expect(screen.getByText('settings.downloadLocation.clear')).toBeTruthy();
    expect(screen.getByRole('status')).toHaveTextContent('settings.downloadLocation.restoreEmpty');
  });

  it('clear releases the tree and resets the mirror', async () => {
    _isAndroid = true;
    pub.getTree.mockResolvedValue({
      treeUri: 'content://tree/abc',
      displayName: 'MyDownloads',
      valid: true,
    });
    await mount();
    expect(useSettingsStore.getState().downloadTreeUri).toBe('content://tree/abc');
    const clear = screen.getByText('settings.downloadLocation.clear');
    fireEvent.click(clear);
    await waitFor(() => {
      expect(pub.clearTree).toHaveBeenCalled();
    });
    expect(backup.preparePublicBackupForTreeSelection).toHaveBeenCalledTimes(1);
    expect(backup.resumePublicBackupAfterTreeSelection).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().downloadTreeUri).toBeNull();
  });

  it('cancelling the picker leaves the current selection untouched', async () => {
    _isAndroid = true;
    pub.openDocumentTree.mockRejectedValue(new Error('cancelled'));
    await mount();
    const pick = screen.getByText('settings.downloadLocation.select');
    fireEvent.click(pick);
    await waitFor(() => {
      expect(backup.resumePublicBackupAfterTreeSelection).toHaveBeenCalledTimes(1);
    });
    expect(useSettingsStore.getState().downloadTreeUri).toBeNull();
    expect(backup.activatePublicBackupForSelectedTree).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('manually restores download metadata and settings from the selected folder', async () => {
    _isAndroid = true;
    pub.getTree.mockResolvedValue({
      treeUri: 'content://tree/abc',
      displayName: 'MyDownloads',
      valid: true,
    });
    backup.activatePublicBackupForSelectedTree.mockResolvedValue({
      treeAvailable: true,
      settingsRestored: true,
      downloadsImported: 2,
      downloadsDiscovered: 0,
      partialDownloads: 0,
      skipped: 0,
      failed: 0,
    });
    await mount();

    fireEvent.click(screen.getByText('settings.downloadLocation.restore'));
    await waitFor(() => {
      expect(backup.activatePublicBackupForSelectedTree).toHaveBeenCalledWith({
        restoreSettings: true,
      });
    });
    expect(screen.getByRole('status')).toHaveTextContent('settings.downloadLocation.restoreDone');
  });

  it('releases the picker freeze and surfaces an error when activation fails', async () => {
    _isAndroid = true;
    pub.openDocumentTree.mockResolvedValue({
      treeUri: 'content://tree/abc',
      displayName: 'MyDownloads',
    });
    backup.activatePublicBackupForSelectedTree.mockRejectedValue(new Error('restore failed'));
    await mount();

    fireEvent.click(screen.getByText('settings.downloadLocation.select'));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'settings.downloadLocation.restoreFailed',
      );
    });
    expect(backup.resumePublicBackupAfterTreeSelection).toHaveBeenCalledTimes(1);
  });
});
