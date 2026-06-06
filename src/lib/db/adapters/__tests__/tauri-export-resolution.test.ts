// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeDb = {
  execute: vi.fn(async () => ({ rowsAffected: 0, lastInsertId: 0 })),
  select: vi.fn(async () => []),
  close: vi.fn(async () => true),
};

function makeDatabaseClass() {
  return class {
    static load = vi.fn(async () => fakeDb);
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadAdapterWith(moduleShape: any) {
  vi.resetModules();
  vi.doMock('@tauri-apps/plugin-sql', () => moduleShape);
  const { TauriAdapter } = await import('../tauri');
  return TauriAdapter;
}

describe('TauriAdapter — defensive Database export resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('loads from the standard default export', async () => {
    const Database = makeDatabaseClass();
    const Adapter = await loadAdapterWith({ default: Database, Database: undefined });

    await expect(Adapter.create('sqlite:test.db')).resolves.toBeDefined();

    expect(Database.load).toHaveBeenCalledWith('sqlite:test.db');
    expect(fakeDb.execute).toHaveBeenCalledWith('PRAGMA journal_mode = WAL', []);
    expect(fakeDb.execute).toHaveBeenCalledWith('PRAGMA foreign_keys = ON', []);
  });

  it('loads from a named Database export when default interop is missing', async () => {
    const Database = makeDatabaseClass();
    const Adapter = await loadAdapterWith({ default: undefined, Database });

    await expect(Adapter.create('sqlite:test.db')).resolves.toBeDefined();

    expect(Database.load).toHaveBeenCalledWith('sqlite:test.db');
  });

  it('loads from nested default interop shapes', async () => {
    const Database = makeDatabaseClass();
    const Adapter = await loadAdapterWith({ default: { default: Database }, Database: undefined });

    await expect(Adapter.create('sqlite:test.db')).resolves.toBeDefined();

    expect(Database.load).toHaveBeenCalledWith('sqlite:test.db');
  });

  it('throws an actionable error when no Database.load export exists', async () => {
    const Adapter = await loadAdapterWith({ default: {}, Database: undefined, other: true });

    await expect(Adapter.create('sqlite:test.db')).rejects.toThrow(
      /Database\.load export not found/,
    );
    await expect(Adapter.create('sqlite:test.db')).rejects.toThrow(/module keys: \[/);
  });
});
