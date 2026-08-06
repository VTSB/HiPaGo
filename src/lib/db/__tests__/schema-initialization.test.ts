// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbAdapter } from '../adapter';

const mocks = vi.hoisted(() => ({
  createTauri: vi.fn(),
  runMigrations: vi.fn(async () => {}),
}));

vi.mock('@/lib/utils/platform', () => ({
  isTauri: vi.fn(() => true),
  isCapacitor: vi.fn(() => false),
}));

vi.mock('../adapters/tauri', () => ({
  TauriAdapter: { create: mocks.createTauri },
}));

vi.mock('../migrations', () => ({ runMigrations: mocks.runMigrations }));

import { closeDb, isDbInitialized } from '../adapter';
import { initializeDatabase } from '../schema';

function fakeAdapter(overrides: Partial<DbAdapter> = {}): DbAdapter {
  return {
    execute: vi.fn(async () => ({ changes: 0, lastInsertRowId: 0 })),
    query: vi.fn(async () => []),
    exec: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('database initialization lifecycle', () => {
  beforeEach(async () => {
    if (isDbInitialized()) await closeDb();
    mocks.createTauri.mockReset();
    mocks.runMigrations.mockReset();
    mocks.runMigrations.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (isDbInitialized()) await closeDb();
  });

  it('shares an in-flight attempt and allows retry after that exact attempt rejects', async () => {
    const retryAdapter = fakeAdapter();
    mocks.createTauri
      .mockRejectedValueOnce(new Error('open failed'))
      .mockResolvedValueOnce(retryAdapter);

    const first = initializeDatabase();
    const concurrent = initializeDatabase();

    expect(concurrent).toBe(first);
    await expect(first).rejects.toThrow('open failed');
    await expect(initializeDatabase()).resolves.toBeUndefined();
    expect(mocks.createTauri).toHaveBeenCalledTimes(2);
  });

  it('closes a partially opened adapter before retrying initialization', async () => {
    const schemaError = new Error('schema failed');
    const incompleteAdapter = fakeAdapter({ exec: vi.fn().mockRejectedValue(schemaError) });
    const retryAdapter = fakeAdapter();
    mocks.createTauri.mockResolvedValueOnce(incompleteAdapter).mockResolvedValueOnce(retryAdapter);

    await expect(initializeDatabase()).rejects.toThrow('schema failed');
    expect(incompleteAdapter.close).toHaveBeenCalledOnce();

    await expect(initializeDatabase()).resolves.toBeUndefined();
    expect(mocks.createTauri).toHaveBeenCalledTimes(2);
  });

  it('can initialize a fresh adapter after closeDb closes the current one', async () => {
    const firstAdapter = fakeAdapter();
    const secondAdapter = fakeAdapter();
    mocks.createTauri.mockResolvedValueOnce(firstAdapter).mockResolvedValueOnce(secondAdapter);

    await initializeDatabase();
    await closeDb();
    await initializeDatabase();

    expect(firstAdapter.close).toHaveBeenCalledOnce();
    expect(mocks.createTauri).toHaveBeenCalledTimes(2);
  });
});
