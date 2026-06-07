// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async (cmd: string) => {
  switch (cmd) {
    case 'plugin:sql|load':
      return 'sqlite:test.db';
    case 'plugin:sql|execute':
      return [1, 7];
    case 'plugin:sql|select':
      return [{ id: 1 }];
    case 'plugin:sql|close':
      return true;
    default:
      throw new Error(`unexpected invoke: ${cmd}`);
  }
});

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

vi.mock('@tauri-apps/plugin-sql', () => {
  throw new Error('TauriAdapter must not import @tauri-apps/plugin-sql');
});

describe('TauriAdapter — direct tauri-plugin-sql invoke bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads and configures sqlite without importing the plugin-sql JS binding', async () => {
    const { TauriAdapter } = await import('../tauri');

    await expect(TauriAdapter.create('sqlite:test.db')).resolves.toBeDefined();

    expect(invoke).toHaveBeenNthCalledWith(1, 'plugin:sql|load', { db: 'sqlite:test.db' });
    expect(invoke).toHaveBeenNthCalledWith(2, 'plugin:sql|execute', {
      db: 'sqlite:test.db',
      query: 'PRAGMA journal_mode = WAL',
      values: [],
    });
    expect(invoke).toHaveBeenNthCalledWith(3, 'plugin:sql|execute', {
      db: 'sqlite:test.db',
      query: 'PRAGMA foreign_keys = ON',
      values: [],
    });
  });

  it('executes, selects, and closes through plugin commands', async () => {
    const { TauriAdapter } = await import('../tauri');
    const adapter = await TauriAdapter.create('sqlite:test.db');
    vi.clearAllMocks();

    await expect(adapter.execute('INSERT INTO t VALUES (?)', [1])).resolves.toEqual({
      changes: 1,
      lastInsertRowId: 7,
    });
    await expect(adapter.query('SELECT * FROM t', [])).resolves.toEqual([{ id: 1 }]);
    await expect(adapter.close()).resolves.toBeUndefined();

    expect(invoke).toHaveBeenNthCalledWith(1, 'plugin:sql|execute', {
      db: 'sqlite:test.db',
      query: 'INSERT INTO t VALUES (?)',
      values: [1],
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'plugin:sql|select', {
      db: 'sqlite:test.db',
      query: 'SELECT * FROM t',
      values: [],
    });
    expect(invoke).toHaveBeenNthCalledWith(3, 'plugin:sql|close', { db: 'sqlite:test.db' });
  });

  it('uses an app DB path covered by the packaged Tauri SQL capability', async () => {
    const { TAURI_DB_PATH } = await import('../tauri');
    const capability = await import('../../../../../src-tauri/capabilities/default.json');
    const permissions = capability.default.permissions as Array<string | { identifier: string; allow?: Array<{ path?: string }> }>;

    expect(TAURI_DB_PATH).toBe('sqlite:hipago.db');
    expect(permissions).toContain('sql:allow-load');
    expect(permissions).toContain('sql:allow-execute');
    expect(permissions).toContain('sql:allow-select');
    expect(permissions).toContain('sql:allow-close');
  });
});
