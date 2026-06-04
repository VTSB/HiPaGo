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
import { render, screen, fireEvent, act } from '@testing-library/react';
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

// ── i18n passthrough — echo keys ────────────────────────────────────────────
vi.mock('@/lib/i18n/useT', () => ({ useT: () => (k: string) => k }));

import { DownloadLocationCard } from '../DownloadLocationCard';
import { useSettingsStore } from '@/lib/store/settings';

beforeEach(() => {
  _isAndroid = false;
  pub.getTree.mockReset().mockResolvedValue({ treeUri: null, displayName: null, valid: false });
  pub.openDocumentTree.mockReset();
  pub.clearTree.mockReset().mockResolvedValue(undefined);
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
  });

  it('picking a folder stores tree + name and shows change/clear', async () => {
    _isAndroid = true;
    pub.openDocumentTree.mockResolvedValue({ treeUri: 'content://tree/abc', displayName: 'MyDownloads' });
    await mount();
    const pick = screen.getByText('settings.downloadLocation.select');
    await act(async () => {
      fireEvent.click(pick);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useSettingsStore.getState().downloadTreeUri).toBe('content://tree/abc');
    expect(useSettingsStore.getState().downloadTreeName).toBe('MyDownloads');
    expect(screen.getByText('MyDownloads')).toBeTruthy();
    expect(screen.getByText('settings.downloadLocation.change')).toBeTruthy();
    expect(screen.getByText('settings.downloadLocation.clear')).toBeTruthy();
  });

  it('clear releases the tree and resets the mirror', async () => {
    _isAndroid = true;
    pub.getTree.mockResolvedValue({ treeUri: 'content://tree/abc', displayName: 'MyDownloads', valid: true });
    await mount();
    expect(useSettingsStore.getState().downloadTreeUri).toBe('content://tree/abc');
    const clear = screen.getByText('settings.downloadLocation.clear');
    await act(async () => {
      fireEvent.click(clear);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pub.clearTree).toHaveBeenCalled();
    expect(useSettingsStore.getState().downloadTreeUri).toBeNull();
  });

  it('cancelling the picker leaves the current selection untouched', async () => {
    _isAndroid = true;
    pub.openDocumentTree.mockRejectedValue(new Error('cancelled'));
    await mount();
    const pick = screen.getByText('settings.downloadLocation.select');
    await act(async () => {
      fireEvent.click(pick);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useSettingsStore.getState().downloadTreeUri).toBeNull();
  });
});
