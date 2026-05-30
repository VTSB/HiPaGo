// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fake @capacitor-community/sqlite. `isConnectionResult` is flipped per test to
// exercise the fresh-connection vs reuse-existing-connection branches.
const state = { isConnectionResult: false };
const fakeDb = {
  open: vi.fn(async () => {}),
  execute: vi.fn(async () => {}),
  run: vi.fn(async () => ({ changes: { changes: 0, lastId: 0 } })),
  query: vi.fn(async () => ({ values: [] })),
  close: vi.fn(async () => {}),
};
const createConnection = vi.fn(async () => fakeDb);
const retrieveConnection = vi.fn(async () => fakeDb);
const checkConnectionsConsistency = vi.fn(async () => ({ result: true }));
const isConnection = vi.fn(async () => ({ result: state.isConnectionResult }));

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: class {
    checkConnectionsConsistency = checkConnectionsConsistency;
    isConnection = isConnection;
    retrieveConnection = retrieveConnection;
    createConnection = createConnection;
  },
}));

import { CapacitorAdapter } from '../capacitor';

describe('CapacitorAdapter.create — idempotent connection acquisition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.isConnectionResult = false;
  });

  it('creates a fresh connection when none exists', async () => {
    state.isConnectionResult = false;
    await CapacitorAdapter.create('hipago');
    expect(createConnection).toHaveBeenCalledOnce();
    expect(retrieveConnection).not.toHaveBeenCalled();
    expect(fakeDb.open).toHaveBeenCalledOnce();
  });

  it('reuses the existing connection instead of throwing "already exists"', async () => {
    state.isConnectionResult = true;
    await CapacitorAdapter.create('hipago');
    expect(retrieveConnection).toHaveBeenCalledOnce();
    expect(createConnection).not.toHaveBeenCalled();
    expect(fakeDb.open).toHaveBeenCalledOnce();
  });

  it('falls back to retrieve when createConnection throws "already exists"', async () => {
    state.isConnectionResult = false; // takes the create-first branch
    createConnection.mockRejectedValueOnce(new Error('Connection hipago already exists'));
    await CapacitorAdapter.create('hipago');
    expect(createConnection).toHaveBeenCalledOnce();
    expect(retrieveConnection).toHaveBeenCalledOnce(); // fallback
    expect(fakeDb.open).toHaveBeenCalledOnce();
  });

  it('falls back to a fresh create when retrieve fails on a stale handle', async () => {
    state.isConnectionResult = true; // takes the retrieve-first branch
    retrieveConnection.mockRejectedValueOnce(new Error('Connection hipago not available'));
    await CapacitorAdapter.create('hipago');
    expect(retrieveConnection).toHaveBeenCalledOnce();
    expect(createConnection).toHaveBeenCalledOnce(); // fallback
    expect(fakeDb.open).toHaveBeenCalledOnce();
  });

  it('throws a step-named error so the failing native step is visible on device', async () => {
    state.isConnectionResult = false;
    fakeDb.open.mockRejectedValueOnce(new Error('unable to open database file'));
    await expect(CapacitorAdapter.create('hipago')).rejects.toThrow(
      /capacitor: open failed: unable to open database file/,
    );
  });
});
