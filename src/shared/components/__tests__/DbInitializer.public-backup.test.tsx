/** @vitest-environment jsdom */

import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbInitializer } from '../DbInitializer';

const boot = vi.hoisted(() => ({
  calls: [] as string[],
  restore: vi.fn(async () => undefined),
  migrate: vi.fn(async () => ({ migrated: 0, reconciled: 0 })),
  reconcile: vi.fn(async () => undefined),
  start: vi.fn(),
}));

const dbStatusState = vi.hoisted(() => ({
  tagsStale: false,
  setDbError: vi.fn(),
}));

vi.mock('@/lib/utils/platform', () => ({ isAndroid: () => true }));

vi.mock('@/lib/db/schema', () => ({
  initializeDatabase: vi.fn(async () => {
    boot.calls.push('database');
  }),
}));

vi.mock('@/lib/storage/public-backup', () => ({
  restorePublicBackup: vi.fn(async () => {
    boot.calls.push('restore');
    return boot.restore();
  }),
  startPublicBackupSync: vi.fn(() => {
    boot.calls.push('start');
    boot.start();
  }),
}));

vi.mock('@/lib/storage/migrate-downloads', () => ({
  migrateDownloadsToPublic: vi.fn(async () => {
    boot.calls.push('migrate');
    return boot.migrate();
  }),
  restoreDownloadsFromPublicFolder: vi.fn(async () => ({
    imported: 0,
    skipped: 0,
    failed: 0,
  })),
}));

vi.mock('@/lib/store/reconcile-queue', () => ({
  reconcileQueue: vi.fn(async () => {
    boot.calls.push('reconcile');
    return boot.reconcile();
  }),
}));

vi.mock('@/lib/db/init', () => ({
  checkDbReady: vi.fn(async () => {
    boot.calls.push('ready');
    return true;
  }),
}));

vi.mock('@/lib/db/gallery', () => ({ cleanupStaleCache: vi.fn(async () => undefined) }));
vi.mock('@/lib/db/tag-sync', () => ({ runTagSync: vi.fn() }));

vi.mock('@/lib/store/db-status', () => ({
  useDbStatusStore: Object.assign(
    (selector: (state: typeof dbStatusState) => unknown) => selector(dbStatusState),
    { getState: () => dbStatusState },
  ),
}));

vi.mock('@/lib/store/tag-i18n', () => ({
  useTagI18nStore: {
    getState: () => ({ loadLocale: vi.fn(async () => undefined) }),
  },
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    getState: () => ({ locale: 'en' }),
    subscribe: vi.fn(() => () => undefined),
  },
}));

describe('DbInitializer Android public backup ordering', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    boot.calls.length = 0;
    boot.restore.mockReset().mockResolvedValue(undefined);
    boot.migrate.mockReset().mockResolvedValue({ migrated: 0, reconciled: 0 });
    boot.reconcile.mockReset().mockResolvedValue(undefined);
    boot.start.mockReset();
    dbStatusState.setDbError.mockReset();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('restores before migration/reconciliation and starts writes last', async () => {
    render(<DbInitializer />);

    await waitFor(() => expect(boot.calls).toContain('ready'));
    expect(boot.calls).toEqual(['database', 'restore', 'migrate', 'reconcile', 'start', 'ready']);
  });

  it('continues boot and enables future backups when restore fails', async () => {
    boot.restore.mockRejectedValueOnce(new Error('corrupt backup'));
    render(<DbInitializer />);

    await waitFor(() => expect(boot.calls).toContain('ready'));
    expect(boot.calls).toEqual(['database', 'restore', 'migrate', 'reconcile', 'start', 'ready']);
  });
});
